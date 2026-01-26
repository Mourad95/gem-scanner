/**
 * Service pour surveiller les nouveaux tokens pump.fun via Solana RPC WebSocket
 * VERSION OPTIMISÉE "ANTI-429" : Évite les appels inutiles
 * @module services/solanaMonitor
 */

import WebSocket from 'ws';
import axios from 'axios';
import type { TokenData } from './analyzer.js';
import type { SolanaConfig } from '../config/settings.js';
import { fetchTokenDataFromBlockchain, fetchBondingCurveReserves } from './blockchainDataService.js';
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

      const tokenData = await this.extractTokenData(transaction);
      
      if (tokenData && tokenData.address) {
        console.log(`   ✅ Mint address trouvé: ${tokenData.address}`);
        
        // FAST-PATH: Si métadonnées trouvées dans les logs, on skip l'enrichissement des métadonnées
        // MAIS on récupère toujours les réserves depuis la blockchain (nécessaire pour Market Cap et Bonding Curve)
        if (tokenData.metadata?.name && tokenData.metadata?.name !== 'Unknown') {
          console.log(`   ✅ Métadonnées trouvées dans les logs: ${tokenData.metadata.name}, ${tokenData.metadata.symbol || 'N/A'}`);
          
          // Récupérer les réserves depuis la blockchain (nécessaire pour Market Cap et Bonding Curve)
          console.log(`   🔗 Récupération des réserves depuis la blockchain...`);
          const reserves = await fetchBondingCurveReserves(
            tokenData.address,
            { rpcUrl: this.rpcUrl, rpcKey: this.rpcKey }
          );
          
          if (reserves) {
            tokenData.reserves = reserves;
            console.log(`   ✅ Réserves récupérées: ${reserves.vSolReserves.toFixed(2)} SOL, ${reserves.tokenReserves.toFixed(0)} tokens`);
          } else {
            console.log(`   ⚠️  Réserves non disponibles (bonding curve peut-être pas encore créée)`);
          }
          
          if (this.onNewTokenCallback) {
            this.onNewTokenCallback(tokenData);
          }
        } else {
          // SLOW-PATH: Appel RPC complet (métadonnées + réserves)
          console.log(`   🔍 Enrichissement complet (métadonnées + réserves)...`);
          const enrichedTokenData = await this.enrichTokenData(tokenData.address);
          const finalTokenData: TokenData = {
            ...tokenData,
            ...enrichedTokenData,
            metadata: enrichedTokenData?.metadata || tokenData.metadata,
            reserves: enrichedTokenData?.reserves || tokenData.reserves,
          };
          
          if (finalTokenData.metadata?.name || finalTokenData.metadata?.symbol) {
            console.log(`   ✅ Métadonnées finales: ${finalTokenData.metadata.name || 'N/A'}, ${finalTokenData.metadata.symbol || 'N/A'}`);
          }
          
          if (finalTokenData.reserves) {
            console.log(`   ✅ Réserves finales: ${finalTokenData.reserves.vSolReserves.toFixed(2)} SOL, ${finalTokenData.reserves.tokenReserves.toFixed(0)} tokens`);
          }
          
          if (this.onNewTokenCallback) {
            this.onNewTokenCallback(finalTokenData);
          }
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
      // Gérer les erreurs 429 avec backoff
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        rpcRateLimiter.backoff();
        // Silent - évite le spam dans les logs
      }
      return null;
    }
  }

  /**
   * Récupère les métadonnées off-chain (image + réseaux sociaux) depuis l'URI
   * @param uri - URI des métadonnées (peut être IPFS ou HTTP)
   * @returns Objet avec image et social (twitter, telegram, website)
   */
  private async fetchOffChainMetadata(uri: string): Promise<{
    image?: string;
    social?: { twitter?: string; telegram?: string; website?: string };
  }> {
    try {
      // Gérer les liens IPFS : ipfs:// -> https://ipfs.io/ipfs/
      let jsonUrl = uri.trim();
      if (jsonUrl.startsWith('ipfs://')) {
        jsonUrl = jsonUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
      } else if (jsonUrl.startsWith('ipfs/')) {
        jsonUrl = `https://ipfs.io/${jsonUrl}`;
      }

      // Requête GET avec timeout court pour ne pas ralentir le bot
      const response = await axios.get(jsonUrl, {
        timeout: 1500,
        headers: {
          'Accept': 'application/json',
        },
      });

      const json = response.data as Record<string, unknown>;

      // Structure pump.fun : les réseaux sociaux peuvent être à la racine ou dans extensions
      const social: { twitter?: string; telegram?: string; website?: string } = {};

      // Chercher Twitter (plusieurs variantes possibles)
      const twitter = 
        json['twitter'] as string | undefined ||
        json['Twitter'] as string | undefined ||
        (json['extensions'] as Record<string, unknown> | undefined)?.['twitter'] as string | undefined ||
        (json['extensions'] as Record<string, unknown> | undefined)?.['Twitter'] as string | undefined;
      
      if (twitter) {
        // Nettoyer l'URL Twitter (enlever @ si présent, ajouter https:// si absent)
        let twitterUrl = String(twitter).trim();
        if (twitterUrl.startsWith('@')) {
          twitterUrl = twitterUrl.substring(1);
        }
        if (twitterUrl && !twitterUrl.startsWith('http')) {
          twitterUrl = `https://twitter.com/${twitterUrl}`;
        }
        if (twitterUrl) social.twitter = twitterUrl;
      }

      // Chercher Telegram
      const telegram = 
        json['telegram'] as string | undefined ||
        json['Telegram'] as string | undefined ||
        (json['extensions'] as Record<string, unknown> | undefined)?.['telegram'] as string | undefined ||
        (json['extensions'] as Record<string, unknown> | undefined)?.['Telegram'] as string | undefined;
      
      if (telegram) {
        let telegramUrl = String(telegram).trim();
        if (telegramUrl && !telegramUrl.startsWith('http')) {
          telegramUrl = `https://t.me/${telegramUrl.replace('@', '')}`;
        }
        if (telegramUrl) social.telegram = telegramUrl;
      }

      // Chercher Website
      const website = 
        json['website'] as string | undefined ||
        json['Website'] as string | undefined ||
        json['homepage'] as string | undefined ||
        (json['extensions'] as Record<string, unknown> | undefined)?.['website'] as string | undefined;
      
      if (website) {
        let websiteUrl = String(website).trim();
        if (websiteUrl && !websiteUrl.startsWith('http')) {
          websiteUrl = `https://${websiteUrl}`;
        }
        if (websiteUrl) social.website = websiteUrl;
      }

      // Chercher l'image
      const image = 
        json['image'] as string | undefined ||
        json['Image'] as string | undefined ||
        json['imageUrl'] as string | undefined;

      // Gérer les images IPFS aussi
      let imageUrl: string | undefined = undefined;
      if (image) {
        imageUrl = String(image).trim();
        if (imageUrl.startsWith('ipfs://')) {
          imageUrl = imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
        }
      }

      return {
        ...(imageUrl ? { image: imageUrl } : {}),
        ...(Object.keys(social).length > 0 ? { social } : {}),
      };
    } catch (error) {
      // Silent fail - si l'URI n'est pas accessible, on continue sans métadonnées off-chain
      return {};
    }
  }

  private async extractTokenData(transaction: SolanaTransaction): Promise<TokenData | null> {
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

      // FAST-PATH: Extraire name/symbol directement depuis les logs (évite l'appel RPC)
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

      // Chercher aussi dans les instructions parsées
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

      // Chercher dans les innerInstructions aussi
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

      // Si on a trouvé une URI, récupérer immédiatement les métadonnées off-chain (réseaux sociaux)
      let offChainMetadata: {
        image?: string;
        social?: { twitter?: string; telegram?: string; website?: string };
      } = {};

      if (uri) {
        console.log(`   🔗 URI trouvée dans les logs, récupération des métadonnées off-chain...`);
        offChainMetadata = await this.fetchOffChainMetadata(uri);
        
        if (offChainMetadata.social && Object.keys(offChainMetadata.social).length > 0) {
          const socials = Object.keys(offChainMetadata.social).join(', ');
          console.log(`   ✅ Réseaux sociaux trouvés: ${socials}`);
        }
      }

      return {
        address: mintAddress,
        metadata: name || symbol ? {
          name: name || 'Unknown',
          symbol: symbol || 'Unknown',
          ...(offChainMetadata.image ? { image: offChainMetadata.image } : {}),
          ...(offChainMetadata.social && Object.keys(offChainMetadata.social).length > 0 
            ? { social: offChainMetadata.social } 
            : {}),
        } : undefined,
        // Ne pas mettre de réserves par défaut - elles seront récupérées depuis la blockchain
        // Si les réserves ne sont pas disponibles, calculateMarketCap retournera 0
        reserves: undefined,
      };
    } catch (error) {
      return null;
    }
  }

  private async enrichTokenData(mintAddress: string): Promise<TokenData | null> {
    try {
      // Utiliser le service optimisé blockchainDataService
      const blockchainData = await fetchTokenDataFromBlockchain(
        mintAddress,
        { rpcUrl: this.rpcUrl, rpcKey: this.rpcKey }
      );

      if (blockchainData && blockchainData.metadata?.name) {
        return {
          address: mintAddress,
          ...blockchainData,
        } as TokenData;
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  stop(): void {
    if (this.ws) this.ws.close();
    if (this.processingInterval) clearInterval(this.processingInterval);
  }
}
