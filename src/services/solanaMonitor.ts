/**
 * Service pour surveiller les nouveaux tokens pump.fun via Solana RPC WebSocket
 * @module services/solanaMonitor
 */

import WebSocket from 'ws';
import axios from 'axios';
import type { TokenData } from './analyzer.js';
import type { SolanaConfig } from '../config/settings.js';
import { fetchTokenDataFromBlockchain } from './blockchainDataService.js';
// 👇 CORRECTION ICI : On importe le bon service optimisé

const PUMP_FUN_BONDING_CURVE = '6EF8rrecthR5DkZJvT6uS8z6yL7GV8S7Zf4m1G8m7f23';
const MAYHEM_PROGRAM_ID = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e';

/**
 * Petit utilitaire pour laisser le temps au RPC de respirer
 */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface ParsedInstruction {
  program: string;
  programId: string;
  parsed?: {
    type: string;
    info?: Record<string, unknown>;
  };
  accounts?: string[];
  data?: string;
}

interface SolanaTransaction {
  signature: string;
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    innerInstructions?: Array<{
      index: number;
      instructions: ParsedInstruction[];
    }>;
    logMessages: string[];
    postBalances: number[];
    preBalances: number[];
    postTokenBalances?: Array<{
      accountIndex: number;
      mint: string;
      owner?: string;
      uiTokenAmount?: {
        uiAmount: number;
        decimals: number;
      };
    }>;
    preTokenBalances?: Array<{
      accountIndex: number;
      mint: string;
    }>;
  };
  transaction: {
    message: {
      accountKeys: Array<{
        pubkey: string;
        signer: boolean;
        writable: boolean;
      }>;
      instructions: ParsedInstruction[];
    };
  };
}

interface PendingTransaction {
  signature: string;
  logs: string[];
  attempts: number;
  firstSeen: number;
}

export class SolanaMonitor {
  private ws: WebSocket | null = null;
  private rpcUrl: string;
  private rpcKey: string;
  private processedSignatures: Set<string> = new Set();
  private onNewTokenCallback: ((tokenData: TokenData) => void) | null = null;
  private pendingTransactions: Map<string, PendingTransaction> = new Map();
  private processingInterval: NodeJS.Timeout | null = null;

  constructor(solana: SolanaConfig) {
    this.rpcUrl = solana.rpcUrl;
    this.rpcKey = (solana.rpcKey || '');
  }

  private prepareRpcHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const hasApiKeyInUrl = this.rpcUrl.includes('api-key=') || this.rpcUrl.includes('apikey=');
    if (!hasApiKeyInUrl && this.rpcKey) {
      headers['Authorization'] = `Bearer ${this.rpcKey}`;
    }
    return headers;
  }

  async start(onNewToken: (tokenData: TokenData) => void): Promise<void> {
    this.onNewTokenCallback = onNewToken;
    const wsUrl = this.rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
          console.log('✅ WebSocket Helius connecté');
          
          const subscribeBondingCurve = {
            jsonrpc: '2.0',
            id: 1,
            method: 'logsSubscribe',
            params: [
              { mentions: [PUMP_FUN_BONDING_CURVE] },
              { commitment: 'confirmed' },
            ],
          };

          const subscribeMayhem = {
            jsonrpc: '2.0',
            id: 2,
            method: 'logsSubscribe',
            params: [
              { mentions: [MAYHEM_PROGRAM_ID] },
              { commitment: 'confirmed' },
            ],
          };

          if (this.ws) {
            this.ws.send(JSON.stringify(subscribeBondingCurve));
            this.ws.send(JSON.stringify(subscribeMayhem));
            console.log(`📡 Surveillance des logs activée...`);
          }
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (error) {
            // Silence
          }
        });

        this.ws.on('error', (error) => {
          console.error('❌ Erreur WebSocket Solana:', error);
          reject(error);
        });

        this.ws.on('close', () => {
          console.log('⚠️ WebSocket Solana fermé, reconnexion...');
          setTimeout(() => {
            this.start(onNewToken).catch(console.error);
          }, 5000);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;

    if (msg['method'] === 'logsNotification') {
      const params = msg['params'] as Record<string, unknown>;
      const result = params['result'] as Record<string, unknown>;
      const value = result['value'] as Record<string, unknown>;
      const signature = value['signature'] as string;
      const logs = value['logs'] as string[];

      if (signature && !this.processedSignatures.has(signature)) {
        this.processedSignatures.add(signature);
        this.processLogs(signature, logs);
      }
    }
  }

  private async processLogs(signature: string, logs: string[]): Promise<void> {
    const tokenCreationPatterns = [
      /Program.*invoke.*create/i,
      /Program.*invoke.*create_v2/i,
      /Program log:.*create/i,
    ];
    
    const hasTokenCreation = logs.some((log) => 
      tokenCreationPatterns.some((pattern) => pattern.test(log))
    );

    if (!hasTokenCreation) return;

    console.log(`\n🎯 CRÉATION DE TOKEN DÉTECTÉE dans les logs !`);
    console.log(`   Signature: ${signature.substring(0, 16)}...`);

    // Ajout à la file d'attente
    this.pendingTransactions.set(signature, {
      signature,
      logs,
      attempts: 0,
      firstSeen: Date.now(),
    });

    if (!this.processingInterval) {
      this.startProcessingQueue();
    }

    // Attendre 1 seconde avant la première tentative
    // Les transactions sont souvent disponibles après 1-2 secondes
    await sleep(1000);
    
    // Traitement immédiat
    await this.processPendingTransaction(signature);
  }

  private startProcessingQueue(): void {
    this.processingInterval = setInterval(() => {
      this.processPendingTransactions();
    }, 2000);
  }

  private async processPendingTransactions(): Promise<void> {
    const now = Date.now();
    const signaturesToRetry: string[] = [];
    
    for (const [signature, pending] of this.pendingTransactions.entries()) {
      // Supprimer les transactions trop anciennes (30 secondes)
      if (now - pending.firstSeen > 30000) {
        console.log(`   ⏰ Transaction ${signature.substring(0, 16)}... expirée après 30s`);
        this.pendingTransactions.delete(signature);
        continue;
      }
      
      // Retry si le délai est passé (délai progressif)
      const timeSinceFirstSeen = now - pending.firstSeen;
      const expectedDelay = Math.min(pending.attempts * 1000, 5000);
      
      // Si on a attendu assez longtemps depuis la dernière tentative
      if (timeSinceFirstSeen >= expectedDelay && pending.attempts < 5) {
        signaturesToRetry.push(signature);
      }
    }
    
    // Traiter les retries
    for (const signature of signaturesToRetry) {
      await this.processPendingTransaction(signature);
    }
  }

  private async processPendingTransaction(signature: string): Promise<void> {
    const pending = this.pendingTransactions.get(signature);
    if (!pending) return;

    // Délai progressif : 1s, 2s, 3s, 4s, 5s
    const delay = Math.min(pending.attempts * 1000, 5000);
    if (pending.attempts > 0) {
      await sleep(delay);
    }

    pending.attempts++;

    try {
      console.log(`   🔍 Récupération de la transaction (tentative ${pending.attempts})...`);
      const transaction = await this.getTransaction(signature);
      if (!transaction) {
        if (pending.attempts < 5) {
          const nextDelay = Math.min((pending.attempts + 1) * 1000, 5000);
          console.log(`   ⚠️  Transaction non disponible, retry dans ${nextDelay}ms...`);
        } else {
          console.log(`   ❌ Transaction non récupérée après ${pending.attempts} tentatives`);
        }
        return;
      }

      if (transaction.meta?.err) {
        console.log(`   ⚠️  Transaction échouée, ignorée`);
        this.pendingTransactions.delete(signature);
        return;
      }

      console.log(`   ✅ Transaction récupérée (slot: ${transaction.slot})`);

      const tokenData = this.extractTokenData(transaction);
      if (tokenData && tokenData.address) {
        console.log(`   ✅ Mint address trouvé: ${tokenData.address}`);
        
        // Essayer d'extraire les métadonnées directement depuis la transaction
        const transactionMetadata = this.extractMetadataFromTransaction(transaction);
        if (transactionMetadata && (transactionMetadata.name || transactionMetadata.symbol)) {
          console.log(`   ✅ Métadonnées trouvées dans la transaction: ${transactionMetadata.name || 'N/A'}, ${transactionMetadata.symbol || 'N/A'}`);
          // Utiliser directement les métadonnées de la transaction !
          tokenData.metadata = transactionMetadata;
        }
        
        // Si on a déjà les métadonnées de la transaction, on peut enrichir avec la blockchain pour les réserves
        // Sinon, on attend un peu pour laisser le temps aux métadonnées d'être créées
        if (!transactionMetadata || !transactionMetadata.name) {
          const delay = Math.min(2000 + (pending.attempts * 500), 5000);
          console.log(`   ⏳ Attente ${delay}ms pour laisser le temps aux métadonnées d'être créées...`);
          await sleep(delay);
        }

        console.log(`   🔍 Enrichissement des métadonnées...`);
        const enrichedTokenData = await this.enrichTokenData(tokenData.address);
        
        // Fusionner : utiliser les métadonnées de la transaction si disponibles, sinon celles de la blockchain
        const finalTokenData: TokenData = {
          ...tokenData,
          ...enrichedTokenData,
          // Priorité aux métadonnées de la transaction si disponibles
          metadata: transactionMetadata && (transactionMetadata.name || transactionMetadata.symbol)
            ? { ...enrichedTokenData?.metadata, ...transactionMetadata }
            : enrichedTokenData?.metadata || tokenData.metadata,
        };
        
        // Log pour confirmer que les métadonnées sont bien utilisées
        if (finalTokenData.metadata?.name || finalTokenData.metadata?.symbol) {
          console.log(`   ✅ Métadonnées finales: ${finalTokenData.metadata.name || 'N/A'}, ${finalTokenData.metadata.symbol || 'N/A'}`);
        }
        
        if (this.onNewTokenCallback) {
          this.onNewTokenCallback(finalTokenData);
        }

        this.pendingTransactions.delete(signature);
      } else {
        console.log(`   ⚠️  Mint address non trouvé dans la transaction`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Erreur inconnue';
      if (pending.attempts >= 5) {
        console.log(`   ❌ Échec après ${pending.attempts} tentatives: ${errorMsg.substring(0, 100)}`);
        this.pendingTransactions.delete(signature);
      }
    }
  }

  private async getTransaction(signature: string): Promise<SolanaTransaction | null> {
    try {
      const response = await axios.post(
        this.rpcUrl,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [
            signature,
            { 
              encoding: 'jsonParsed', 
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            },
          ],
        },
        { headers: this.prepareRpcHeaders(), timeout: 8000 }
      );

      const result = response.data?.result as SolanaTransaction | null;
      
      // Si pas de résultat, vérifier s'il y a une erreur
      if (!result && response.data?.error) {
        const error = response.data.error as { code?: number; message?: string };
        // Ne pas logger les erreurs -32602 (Invalid params) ou -32004 (Transaction not found)
        // car c'est normal si la transaction est trop récente
        if (error.code !== -32602 && error.code !== -32004) {
          console.log(`   ⚠️  Erreur RPC: ${error.message || 'Erreur inconnue'}`);
        }
      }
      
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Erreur inconnue';
      // Ne pas logger les timeouts ou erreurs réseau, c'est normal si la transaction est récente
      if (!errorMsg.includes('timeout') && !errorMsg.includes('ECONNREFUSED')) {
        console.log(`   ⚠️  Erreur lors de la récupération: ${errorMsg.substring(0, 100)}`);
      }
      return null;
    }
  }

  /**
   * Extrait les métadonnées (name, symbol) directement depuis la transaction
   * Les instructions pump.fun peuvent contenir les métadonnées dans les données
   */
  private extractMetadataFromTransaction(transaction: SolanaTransaction): { name?: string; symbol?: string } | null {
    try {
      // Chercher dans les instructions pour des données de métadonnées
      const instructions = [
        ...transaction.transaction.message.instructions,
        ...(transaction.meta.innerInstructions?.flatMap(inner => inner.instructions) || []),
      ];

      for (const inst of instructions) {
        // Si l'instruction a des données parsées, chercher name/symbol
        if (inst.parsed?.info) {
          const info = inst.parsed.info as Record<string, unknown>;
          const name = info['name'] as string | undefined;
          const symbol = info['symbol'] as string | undefined;
          
          if (name || symbol) {
            return { name, symbol };
          }
        }
        
        // Les métadonnées sont généralement dans les comptes, pas dans les données brutes
        // On se concentre sur les instructions parsées
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  private extractTokenData(transaction: SolanaTransaction): TokenData | null {
    try {
      let mintAddress: string | null = null;

      // Stratégie fiable pour Pump.fun : Regarder les postTokenBalances
      // Le mint est le token qui a une balance post > 0 et pre = 0 (ou n'existait pas)
      if (transaction.meta.postTokenBalances) {
        const newMint = transaction.meta.postTokenBalances.find(bal => 
            // Souvent le mint a un decimal de 6 pour pump.fun
            bal.uiTokenAmount?.decimals === 6 && 
            bal.uiTokenAmount?.uiAmount !== null
        );
        if (newMint) mintAddress = newMint.mint;
      }

      // Fallback : AccountKeys
      // Le mint est souvent le compte index 1 ou 2 qui est writable et non-signer
      if (!mintAddress && transaction.transaction.message.accountKeys) {
         const accounts = transaction.transaction.message.accountKeys;
         // Sur pump.fun create, le mint est souvent le 2ème ou 3ème compte
         // Fix: Be sure mintAddress is a valid pubkey string and not a Program address.
         for (let i = 0; i < Math.min(accounts.length, 4); i++) {
             const acc = accounts[i];
             // Exclude signers, require writable, and skip Sys/Token programs
             if (
               acc &&
               !acc.signer &&
               acc.writable &&
               typeof acc.pubkey === 'string' &&
               !acc.pubkey.startsWith('111111') && // Exclude System Program
               !acc.pubkey.startsWith('TokenkegQ') // Exclude SPL Token
             ) {
                 mintAddress = acc.pubkey;
                 break;
             }
         }
         }
      if (!mintAddress) {
        return null;
      }

      return {
        address: mintAddress,
        reserves: { vSolReserves: 30, tokenReserves: 1_000_000_000 },
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Enrichit les données : BLOCKCHAIN D'ABORD, API APRES
   */
  private async enrichTokenData(mintAddress: string): Promise<TokenData | null> {
    try {
      // 1. PRIORITÉ ABSOLUE : BLOCKCHAIN (Via le nouveau service optimisé)
      // C'est ici que la magie opère.
      const blockchainData = await fetchTokenDataFromBlockchain(
        mintAddress,
        { rpcUrl: this.rpcUrl, rpcKey: this.rpcKey }
      );
      // Log détaillé pour debug
      if (!blockchainData || !blockchainData.metadata?.name) {
        console.log(`   ⚠️  Aucune métadonnée récupérée depuis la blockchain`);
      }

      // Si la blockchain a trouvé le nom, ON GAGNE ! On retourne direct.
      if (blockchainData && blockchainData.metadata?.name) {
        return {
          address: mintAddress,
          ...blockchainData,
        } as TokenData;
      }

      // 2. PLAN B (Désespoir) : API Pump.fun
      // On n'arrive ici que si la blockchain a échoué (très rare avec le fix)
      if (!blockchainData || !blockchainData.metadata?.name) {
        console.log(`   ⚠️  Blockchain muette, tentative API pump.fun...`);
      }
      const apiUrls = [`https://frontend-api.pump.fun/coins/${mintAddress}`];

      for (const url of apiUrls) {
        try {
          const response = await axios.get(url, {
            timeout: 1000, 
            headers: { 'User-Agent': 'Mozilla/5.0' }
          });
          if (response.status === 200 && response.data.name) {
             // Mapping API data...
             return {
                 address: mintAddress,
                 metadata: {
                     name: response.data.name,
                     symbol: response.data.symbol,
                     description: response.data.description,
                     image: response.data.image,
                     social: { 
                         twitter: response.data.twitter, 
                         telegram: response.data.telegram,
                         website: response.data.website
                     }
                 },
                 reserves: { vSolReserves: 30, tokenReserves: 1_000_000_000 }
             };
          }
        } catch (e) { continue; }
      }

      // 3. ECHEC TOTAL : On renvoie quand même l'adresse pour l'analyser
      // (Peut-être que l'analyzer arrivera à choper des infos via RugCheck plus tard)
      return blockchainData ? { address: mintAddress, ...blockchainData } as TokenData : null;

    } catch (error) {
      return null;
    }
  }

  stop(): void {
    if (this.ws) this.ws.close();
    if (this.processingInterval) clearInterval(this.processingInterval);
  }
}