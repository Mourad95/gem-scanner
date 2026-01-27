/**
 * Service pour surveiller les nouveaux tokens pump.fun via Solana RPC WebSocket
 * VERSION OPTIMISÉE "ANTI-429" : Évite les appels inutiles
 * @module services/solanaMonitor
 */

import WebSocket from 'ws';
import axios from 'axios';
import type { TokenData } from './analyzer.js';
import type { SolanaConfig } from '../config/settings.js';
import { rpcRateLimiter } from './rateLimiter.js';

const PUMP_FUN_BONDING_CURVE = '6EF8rrecthR5DkZJvT6uS8z6yL7GV8S7Zf4m1G8m7f23';
const MAYHEM_PROGRAM_ID = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e';

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
  private lastQueueSaturatedLog: number = 0;

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
      const value = params['result'] as Record<string, unknown> | undefined;
      const resultValue = value?.['value'] as Record<string, unknown> | undefined;
      
      if (resultValue) {
        const signature = resultValue['signature'] as string;
        const logs = resultValue['logs'] as string[];

        if (signature && !this.processedSignatures.has(signature)) {
          this.processedSignatures.add(signature);
          // Nettoyer le cache périodiquement pour éviter les fuites mémoire
          if (this.processedSignatures.size > 10000) {
            this.processedSignatures.clear();
          }
          
          this.processLogs(signature, logs);
        }
      }
    }
  }

  private async processLogs(signature: string, logs: string[]): Promise<void> {
    // Vérification de la file d'attente : si saturée (>20), ignorer les nouveaux tokens
    if (this.pendingTransactions.size > 20) {
      // Log unique pour éviter le spam (une seule fois toutes les 10 secondes)
      const now = Date.now();
      if (!this.lastQueueSaturatedLog || now - this.lastQueueSaturatedLog > 10000) {
        console.log('⚠️ File d\'attente saturée (20+), nouveaux tokens ignorés temporairement.');
        this.lastQueueSaturatedLog = now;
      }
      return;
    }

    const isCreation = logs.some(log => 
      log.includes('Program log: Instruction: Create') || 
      log.includes('Program 6EF8rrecthR5DkZJvT6uS8z6yL7GV8S7Zf4m1G8m7f23 invoke') ||
      /Program.*invoke.*create/i.test(log) ||
      /Program.*invoke.*create_v2/i.test(log)
    );

    if (!isCreation) return;

    console.log(`\n🎯 CRÉATION DE TOKEN DÉTECTÉE dans les logs !`);
    console.log(`   Signature: ${signature.substring(0, 16)}...`);

    this.pendingTransactions.set(signature, {
      signature,
      logs,
      attempts: 0,
      firstSeen: Date.now(),
    });

    if (!this.processingInterval) {
      this.startProcessingQueue();
    }
  }

  private startProcessingQueue(): void {
    this.processingInterval = setInterval(() => {
      this.processPendingTransactions();
    }, 1000); // 1 tick par seconde pour lisser la charge
  }

  private async processPendingTransactions(): Promise<void> {
    const now = Date.now();
    let processedCount = 0; // Compteur pour limiter à 3 par tick

    for (const [signature, pending] of this.pendingTransactions.entries()) {
      // Queue Throttling : Max 3 transactions par tick
      if (processedCount >= 3) break;

      // Supprimer les transactions trop anciennes (45 secondes)
      if (now - pending.firstSeen > 45000) {
        this.pendingTransactions.delete(signature);
        continue;
      }
      
      // Supprimer après 8 tentatives
      if (pending.attempts >= 8) {
        this.pendingTransactions.delete(signature);
        continue;
      }

      await this.processPendingTransaction(signature);
      processedCount++;
    }
  }

  private async processPendingTransaction(signature: string): Promise<void> {
    const pending = this.pendingTransactions.get(signature);
    if (!pending) return;

    pending.attempts++;
    
    // Backoff Intelligent : attendre attempt * 1000ms avant de réessayer
    if (pending.attempts > 1) {
      const backoff = pending.attempts * 1000;
      const timeSinceFirstSeen = Date.now() - pending.firstSeen;
      if (timeSinceFirstSeen < backoff) {
        return; // Pas encore le moment de réessayer
      }
    }

    try {
      const transaction = await this.getTransaction(signature);
      
      if (!transaction) {
        return; // Réessayera au prochain tick
      }

      if (transaction.meta?.err) {
        console.log(`   ⚠️  Transaction échouée, ignorée`);
        this.pendingTransactions.delete(signature);
        return;
      }

      console.log(`   ✅ Transaction récupérée (slot: ${transaction.slot})`);

      // LAZY LOADING STRICT : Extraction UNIQUEMENT depuis les logs (pas d'appel RPC)
      const tokenData = this.extractTokenData(transaction);
      
      if (tokenData && tokenData.address) {
        console.log(`   ✅ Mint address trouvé: ${tokenData.address}`);
        
        // Si le nom est "Unknown", on ignore le token (pas de quarantaine)
        if (!tokenData.metadata?.name || tokenData.metadata.name === 'Unknown') {
          console.log(`   ⏭️  Token ignoré (nom non trouvé dans les logs)`);
          this.pendingTransactions.delete(signature);
          return;
        }
        
        console.log(`   ✅ Métadonnées trouvées dans les logs: ${tokenData.metadata.name}, ${tokenData.metadata.symbol || 'N/A'}`);
        
        // Envoyer le token à la quarantaine (index.ts se chargera de l'enrichissement après 30s)
        if (this.onNewTokenCallback) {
          this.onNewTokenCallback(tokenData);
        }

        this.pendingTransactions.delete(signature);
      } else {
        console.log(`   ⚠️  Mint address non trouvé dans la transaction`);
      }
    } catch (error) {
      // Silent fail - réessayera au prochain tick
    }
  }

  private async getTransaction(signature: string): Promise<SolanaTransaction | null> {
    try {
      // Utiliser rate limiting pour éviter les erreurs 429
      const response = await rpcRateLimiter.execute(async () => {
        return await axios.post(
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
          { headers: this.prepareRpcHeaders(), timeout: 5000 }
        );
      });

      const result = response.data?.result as SolanaTransaction | null;
      
      // Si pas de résultat, vérifier s'il y a une erreur
      if (!result && response.data?.error) {
        const error = response.data.error as { code?: number; message?: string };
        // Ne pas logger les erreurs -32602 (Invalid params) ou -32004 (Transaction not found)
        // car c'est normal si la transaction est trop récente
        if (error.code !== -32602 && error.code !== -32004) {
          // Silent - évite le spam
        }
      }
      
      return result;
    } catch (error) {
      // Gérer les erreurs 429 avec pause globale (géré par le rate limiter)
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        rpcRateLimiter.handle429();
        // Silent - le rate limiter gère déjà le logging discret
      }
      return null;
    }
  }

  /**
   * Extrait les données du token UNIQUEMENT depuis les logs de la transaction
   * LAZY LOADING STRICT : Aucun appel RPC, aucune requête HTTP
   * @param transaction - Transaction Solana
   * @returns TokenData ou null si le nom est "Unknown"
   */
  private extractTokenData(transaction: SolanaTransaction): TokenData | null {
    try {
      let mintAddress: string | null = null;
      let name: string | undefined = undefined;
      let symbol: string | undefined = undefined;
      let uri: string | undefined = undefined;

      // Stratégie 1: postTokenBalances (le plus fiable)
      if (transaction.meta.postTokenBalances) {
        const newMint = transaction.meta.postTokenBalances.find(bal => 
            bal.uiTokenAmount?.decimals === 6 && 
            bal.uiTokenAmount?.uiAmount !== null
        );
        if (newMint) mintAddress = newMint.mint;
      }
      
      // Stratégie 2: AccountKeys (fallback)
      if (!mintAddress && transaction.transaction.message.accountKeys) {
         const accounts = transaction.transaction.message.accountKeys;
         for (let i = 0; i < Math.min(accounts.length, 5); i++) {
             const acc = accounts[i];
             if (acc && !acc.signer && acc.writable && typeof acc.pubkey === 'string') {
                 // Exclure les programmes système
                 if (!acc.pubkey.startsWith('111111') && !acc.pubkey.startsWith('TokenkegQ')) {
                   mintAddress = acc.pubkey;
                   break;
                 }
             }
         }
      }

      if (!mintAddress) return null;

      // PRIORITÉ AUX LOGS : Extraire name/symbol/uri UNIQUEMENT depuis les logs
      const logs = transaction.meta.logMessages || [];
      for (const log of logs) {
          // Chercher les patterns de métadonnées dans les logs
          if (log.includes('name:') || log.includes('symbol:') || log.includes('Name:') || log.includes('Symbol:') || log.includes('uri:') || log.includes('URI:')) {
              // Pattern 1: "name: X, symbol: Y, uri: Z"
              const nameMatch = log.match(/name:\s*([^,\s}]+)/i) || log.match(/Name:\s*([^,\s}]+)/i);
              const symbolMatch = log.match(/symbol:\s*([^,\s}]+)/i) || log.match(/Symbol:\s*([^,\s}]+)/i);
              const uriMatch = log.match(/uri:\s*([^,\s}]+)/i) || log.match(/URI:\s*([^,\s}]+)/i);
              
              if (nameMatch && nameMatch[1]) name = nameMatch[1].trim().replace(/['"]/g, '');
              if (symbolMatch && symbolMatch[1]) symbol = symbolMatch[1].trim().replace(/['"]/g, '');
              if (uriMatch && uriMatch[1]) uri = uriMatch[1].trim().replace(/['"]/g, '');
          }
      }

      // Fallback : Chercher dans les instructions parsées (si pas trouvé dans les logs)
      if ((!name || !symbol) && transaction.transaction.message.instructions) {
        for (const inst of transaction.transaction.message.instructions) {
          if (inst?.parsed?.info) {
            const info = inst.parsed.info as Record<string, unknown>;
            if (!name && info['name']) name = String(info['name']);
            if (!symbol && info['symbol']) symbol = String(info['symbol']);
            if (!uri && info['uri']) uri = String(info['uri']);
          }
        }
      }

      // Fallback : Chercher dans les innerInstructions (si pas trouvé dans les logs)
      if ((!name || !symbol || !uri) && transaction.meta.innerInstructions) {
        for (const inner of transaction.meta.innerInstructions) {
          if (inner?.instructions) {
            for (const inst of inner.instructions) {
              if (inst?.parsed?.info) {
                const info = inst.parsed.info as Record<string, unknown>;
                if (!name && info?.['name']) name = String(info['name']);
                if (!symbol && info?.['symbol']) symbol = String(info['symbol']);
                if (!uri && info?.['uri']) uri = String(info['uri']);
              }
            }
          }
        }
      }

      // FILTRAGE IMMÉDIAT : Si le nom est "Unknown", retourner null (on ignore le token)
      if (!name || name === 'Unknown') {
        return null;
      }

      // FILTRAGE EN AMONT : Rejeter les tokens de mauvaise qualité avant la quarantaine
      const nameLower = name.toLowerCase().trim();
      const symbolLower = (symbol || '').toLowerCase().trim();
      
      // Mots interdits dans le nom ou le symbole (test, shit, pump)
      const blacklistWords = ['test', 'shit', 'pump'];
      const hasBlacklistedWord = blacklistWords.some(word => 
        nameLower.includes(word) || symbolLower.includes(word)
      );
      
      // "coin" seul (pas dans un autre mot comme "coinbase" ou "coincidence")
      const isCoinAlone = nameLower === 'coin' || symbolLower === 'coin' ||
        /\bcoin\b/.test(nameLower) || /\bcoin\b/.test(symbolLower);
      
      // Vérifier si le nom contient uniquement des caractères chinois/russes (pas d'ASCII)
      // Regex pour détecter les caractères chinois (CJK) et cyrilliques
      const cjkCyrillicRegex = /^[\u4e00-\u9fff\u0400-\u04ff\s]+$/;
      const isOnlyCjkCyrillic = cjkCyrillicRegex.test(name) && name.length > 0;
      
      // Rejeter si :
      // - Contient un mot blacklisté (test, shit, pump)
      // - Nom ou symbole est "coin" seul
      // - Nom composé uniquement de caractères chinois/russes (sans ASCII)
      if (hasBlacklistedWord || isCoinAlone || isOnlyCjkCyrillic) {
        return null; // Ignorer le token immédiatement
      }

      // Retourner les données minimales (sans réserves, sans métadonnées off-chain)
      // La quarantaine (index.ts) se chargera de l'enrichissement après 30s
      return {
        address: mintAddress,
        metadata: {
          name: name,
          symbol: symbol || 'Unknown',
          ...(uri ? { image: uri } : {}), // Stocker l'URI comme image temporairement
        },
        reserves: undefined, // Sera récupéré par la quarantaine
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * NOTE: Cette méthode n'est plus utilisée (Lazy Loading strict)
   * L'enrichissement est maintenant fait par la quarantaine (index.ts) après 30s
   * Conservée pour référence mais ne sera jamais appelée
   */
  // private async enrichTokenData(mintAddress: string): Promise<TokenData | null> {
  //   // Supprimée - l'enrichissement est fait par la quarantaine
  // }

  stop(): void {
    if (this.ws) this.ws.close();
    if (this.processingInterval) clearInterval(this.processingInterval);
  }
}
