/**
 * Service pour surveiller les nouveaux tokens pump.fun via Solana RPC WebSocket
 * VERSION "ZÉRO APPEL RPC" : Extraction purement textuelle depuis les logs
 * @module services/solanaMonitor
 */

import WebSocket from 'ws';
import axios from 'axios';
import { PublicKey } from '@solana/web3.js';
import type { TokenData } from './analyzer.js';
import type { SolanaConfig } from '../config/settings.js';

const PUMP_FUN_BONDING_CURVE = '6EF8rrecthR5DkZJvT6uS8z6yL7GV8S7Zf4m1G8m7f23';
const MAYHEM_PROGRAM_ID = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e';

/**
 * Données extraites depuis les logs
 */
interface ParsedTokenLog {
  mint: string | null;
  name: string;
  symbol: string;
  uri: string;
}

/**
 * Cache pour éviter les doublons (protection anti-flood)
 */
interface ProcessedLog {
  signature: string;
  timestamp: number;
}

export class SolanaMonitor {
  private ws: WebSocket | null = null;
  private rpcUrl: string;
  private rpcKey: string;
  private onNewTokenCallback: ((tokenData: TokenData) => void) | null = null;
  
  // Protection anti-flood : Set de signatures déjà traitées
  private processedSignatures: Set<string> = new Set();
  
  // Cache des logs récents pour éviter les doublons Helius (100ms de fenêtre)
  private recentLogs: Map<string, ProcessedLog> = new Map();
  private readonly DEDUP_WINDOW_MS = 100;

  constructor(solana: SolanaConfig) {
    this.rpcUrl = solana.rpcUrl;
    this.rpcKey = solana.rpcKey || '';
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
          console.log('✅ WebSocket Helius connecté (mode Zéro Appel RPC)');
          
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
            console.log('📡 Surveillance des logs activée (extraction textuelle uniquement)');
          }
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());
            
            // Gérer les réponses aux subscriptions (id: 1 ou 2)
            if (message && typeof message === 'object' && 'id' in message) {
              const msg = message as { id: number; result?: unknown; error?: unknown };
              if (msg.id === 1 || msg.id === 2) {
                if (msg.result) {
                  console.log(`✅ Subscription ${msg.id} active, ID: ${msg.result}`);
                } else if (msg.error) {
                  console.error(`❌ Erreur subscription ${msg.id}:`, msg.error);
                }
                return; // Ne pas traiter les réponses de subscription comme des notifications
              }
            }
            
            this.handleMessage(message);
          } catch (error) {
            console.error('❌ Erreur parsing message WebSocket:', error);
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

    if (msg['method']) {
      const method = msg['method'] as string;
      if (method === 'logsNotification') {
      const params = msg['params'] as Record<string, unknown>;
      const value = params['result'] as Record<string, unknown> | undefined;
      const resultValue = value?.['value'] as Record<string, unknown> | undefined;
      
      if (resultValue) {
        const signature = resultValue['signature'] as string;
        const logs = resultValue['logs'] as string[];

          if (signature && logs && Array.isArray(logs)) {
            // Log temporaire pour debug : voir si des logs arrivent
            const hasPumpFun = logs.some(log => 
              log.includes(PUMP_FUN_BONDING_CURVE) || 
              log.includes(MAYHEM_PROGRAM_ID) ||
              log.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
            );
            
            if (hasPumpFun) {
              console.log(`\n📥 Logs pump.fun reçus (${logs.length} lignes, sig: ${signature.substring(0, 8)}...)`);
          }
          
          this.processLogs(signature, logs).catch(() => {
            // Erreur silencieuse pour ne pas crasher le WebSocket
          });
        }
        }
      }
    }
  }

  /**
   * Traite les logs directement sans aucun appel RPC
   * Protection anti-flood intégrée
   * Fallback RPC si name/symbol OK mais mint manquant
   */
  private async processLogs(signature: string, logs: string[]): Promise<void> {
    // Protection anti-flood : Vérifier si on a déjà traité cette signature récemment
      const now = Date.now();
    const recentLog = this.recentLogs.get(signature);
    
    if (recentLog && (now - recentLog.timestamp) < this.DEDUP_WINDOW_MS) {
      // Doublon détecté dans la fenêtre de 100ms, ignorer
      return;
    }

    // Mettre à jour le cache
    this.recentLogs.set(signature, { signature, timestamp: now });
    
    // Nettoyer le cache des logs anciens (>1 seconde)
    if (this.recentLogs.size > 1000) {
      for (const [sig, log] of this.recentLogs.entries()) {
        if (now - log.timestamp > 1000) {
          this.recentLogs.delete(sig);
        }
      }
    }

    // Vérifier si c'est une création de token
    const isCreation = logs.some(log => 
      log.includes('Program log: Create') || 
      log.includes('Program log: Instruction: Create') || 
      log.includes('Program log: Instruction: CreateV2') ||
      log.includes('Create:') ||
      /Program.*log.*[Cc]reate/i.test(log)
    );

    if (!isCreation) {
        return;
      }

    console.log(`   🔍 Création détectée, extraction des métadonnées...`);

    // Extraction purement textuelle via regex
    const parsed = this.extractTokenDataFromLogs(logs);
    
    if (!parsed) {
      // Parsing échoué -> Ignorer le token (règle stricte)
      console.log(`   ⚠️  Échec extraction des métadonnées`);
          return;
        }
        
    // SAUVETAGE : Si name et symbol sont OK mais mint manquant, récupérer via RPC
    let mintAddress: string | null = parsed.mint;
    if (!mintAddress && parsed.name && parsed.symbol) {
      console.log(`   🔄 Mint manquant, tentative de récupération via RPC...`);
      try {
        const recoveredMint = await this.recoverMintFromTransaction(signature);
        if (recoveredMint) {
          mintAddress = recoveredMint;
          console.log(`   ✅ Mint récupéré via RPC: ${mintAddress.substring(0, 16)}...`);
        } else {
          console.log(`   ⚠️  Impossible de récupérer le mint via RPC`);
          return; // On ignore le token si on ne peut pas récupérer le mint
        }
      } catch (error) {
        console.log(`   ⚠️  Erreur lors de la récupération du mint via RPC`);
        return;
      }
    }

    // Validation finale : on doit avoir un mint valide
    if (!mintAddress) {
      return;
    }
        
    // Vérifier si on a déjà traité cette signature (protection supplémentaire)
    if (this.processedSignatures.has(signature)) {
      return;
    }
    
    this.processedSignatures.add(signature);
    
    // Nettoyer le cache périodiquement pour éviter les fuites mémoire
    if (this.processedSignatures.size > 10000) {
      this.processedSignatures.clear();
    }

    console.log(`\n🎯 TOKEN DÉTECTÉ (extraction textuelle)`);
    console.log(`   Signature: ${signature.substring(0, 16)}...`);
    console.log(`   Mint: ${mintAddress.substring(0, 16)}...`);
    console.log(`   Name: ${parsed.name}, Symbol: ${parsed.symbol}`);

    // Construire le TokenData minimal
    const tokenData: TokenData = {
      address: mintAddress,
      metadata: {
        name: parsed.name,
        symbol: parsed.symbol,
        ...(parsed.uri ? { image: parsed.uri } : {}),
      },
      // reserves sera récupéré plus tard par la quarantaine
    };

    // Envoyer le token au callback (quarantaine)
    if (this.onNewTokenCallback) {
      // Petit délai pour éviter le flood (100ms)
      setTimeout(() => {
        this.onNewTokenCallback?.(tokenData);
      }, 100);
    }
  }

  /**
   * Extrait les données du token UNIQUEMENT depuis les logs avec des regex
   * ZÉRO APPEL RPC - Si le parsing échoue, retourne null (on ignore le token)
   * Les métadonnées sont dans les "Program data" en base64
   */
  private extractTokenDataFromLogs(logs: string[]): ParsedTokenLog | null {
    try {
      let mint: string | null = null;
      let name: string | null = null;
      let symbol: string | null = null;
      let uri: string | null = null;

      // STRATÉGIE 1: Décoder les "Program data" en base64 (format Token Metadata)
      // Les métadonnées sont dans les logs "Program data: [base64]"
      let programDataCount = 0;
      for (const log of logs) {
        if (log.startsWith('Program data: ')) {
          programDataCount++;
          const base64Data = log.substring('Program data: '.length).trim();
          try {
            const decoded = this.decodeTokenMetadata(base64Data);
            if (decoded) {
              if (decoded.mint && !mint) mint = decoded.mint;
              if (decoded.name && !name) name = decoded.name || null;
              if (decoded.symbol && !symbol) symbol = decoded.symbol || null;
              if (decoded.uri && !uri) uri = decoded.uri || null;
            }
          } catch (error) {
            // Ignorer les erreurs de décodage
          }
        }
      }
      
      // Debug : voir combien de Program data on a trouvé
      if (programDataCount > 0) {
        console.log(`   📊 ${programDataCount} "Program data" trouvé(s), mint: ${mint ? '✓' : '✗'}, name: ${name ? '✓' : '✗'}, symbol: ${symbol ? '✓' : '✗'}`);
      }

      // STRATÉGIE 2: Recherche textuelle dans les logs (fallback)
      const logsText = logs.join('\n');
      
      // Pattern compact "Create: mint: [ADDR], name: [NAME], symbol: [SYM], uri: [URI]" (regex améliorée)
      const compactPattern = /[Cc]reate:\s*mint\s*[=:]\s*([1-9A-HJ-NP-Za-km-z]{32,44}),\s*name\s*[=:]\s*([^,\n}]+?),\s*symbol\s*[=:]\s*([^,\n}]+?)(?:,\s*uri\s*[=:]\s*([^\n}]+))?/i;
      const compactMatch = logsText.match(compactPattern);
      if (compactMatch) {
        if (!mint) mint = compactMatch[1]?.trim() || null;
        if (!name) name = compactMatch[2]?.trim().replace(/['"]/g, '') || null;
        if (!symbol) symbol = compactMatch[3]?.trim().replace(/['"]/g, '') || null;
        if (!uri) uri = compactMatch[4]?.trim().replace(/['"]/g, '') || null;
      }

      // Pattern multi-lignes (regex améliorée avec espaces flexibles)
      if (!mint || !name || !symbol) {
        const multilinePattern = /mint\s*[=:]\s*([1-9A-HJ-NP-Za-km-z]{32,44})|name\s*[=:]\s*([^,\n}]+?)|symbol\s*[=:]\s*([^,\n}]+?)|uri\s*[=:]\s*([^\n}]+)/gi;
        const matches = Array.from(logsText.matchAll(multilinePattern));
        for (const match of matches) {
          if (match[1] && !mint) mint = match[1].trim();
          if (match[2] && !name) name = match[2].trim().replace(/['"]/g, '');
          if (match[3] && !symbol) symbol = match[3].trim().replace(/['"]/g, '');
          if (match[4] && !uri) uri = match[4].trim().replace(/['"]/g, '');
        }
      }

      // STRATÉGIE 3: Chercher le mint dans les adresses de programmes invoqués
      // Le mint est souvent dans les account keys, mais on n'a pas accès ici
      // On peut essayer de trouver des patterns d'adresses Solana dans les logs
      if (!mint) {
        // Chercher des adresses Solana valides dans les logs (exactement 32-44 caractères base58)
        // Les adresses Solana valides sont en base58, donc pas de 0, O, I, l
        const addressPattern = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g;
        const addresses = Array.from(logsText.matchAll(addressPattern));
        // Filtrer les adresses connues (programmes système)
        const knownPrograms = [
          '11111111111111111111111111111111',
          'ComputeBudget111111111111111111111111111111',
          'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
          'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
          '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
          'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', // Programme de fees
          PUMP_FUN_BONDING_CURVE,
          MAYHEM_PROGRAM_ID,
        ];
        for (const match of addresses) {
          const addr = match[1];
          if (addr && !knownPrograms.includes(addr)) {
            // Valider que c'est une adresse Solana valide (base58, 32-44 chars)
            // Les adresses Solana standard font généralement 32 ou 44 caractères
            if ((addr.length === 32 || addr.length === 43 || addr.length === 44) && 
                /^[1-9A-HJ-NP-Za-km-z]+$/.test(addr)) {
              // Vérifier que ce n'est pas un pattern suspect (trop de caractères répétés)
              const uniqueChars = new Set(addr).size;
              if (uniqueChars > 10) { // Au moins 10 caractères différents
                mint = addr;
                break;
              }
            }
          }
        }
      }

      // Validation : name et symbol sont obligatoires, mint peut être null (sera récupéré via RPC)
      if (!name || !symbol) {
        return null; // Parsing échoué -> Ignorer le token
      }

      // Validation du format de l'adresse mint si elle existe
      if (mint) {
        // Les adresses Solana valides sont en base58 (pas de 0, O, I, l) et font généralement 32, 43 ou 44 caractères
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || 
            (mint.length !== 32 && mint.length !== 43 && mint.length !== 44)) {
          mint = null; // Adresse invalide, on essaiera de la récupérer via RPC
        }
      }
      
      // Filtrer les noms/symboles suspects (artefacts de parsing)
      // "cv" semble être un artefact commun
      if (name.length <= 2 && (name === 'cv' || name === 'qu' || name === '4l')) {
        return null; // Probablement un artefact
      }

      // Nettoyage des valeurs
      name = name.trim();
      symbol = symbol.trim();
      uri = uri?.trim() || null;

      // Filtrer les tokens de mauvaise qualité
      const nameLower = name.toLowerCase();
      const symbolLower = symbol.toLowerCase();
      
      // Mots interdits
      const blacklistWords = ['test', 'shit', 'pump'];
      const hasBlacklistedWord = blacklistWords.some(word => 
        nameLower.includes(word) || symbolLower.includes(word)
      );
      
      // "coin" seul
      const isCoinAlone = nameLower === 'coin' || symbolLower === 'coin' ||
        /\bcoin\b/.test(nameLower) || /\bcoin\b/.test(symbolLower);
      
      // Caractères uniquement chinois/russes (sans ASCII)
      const cjkCyrillicRegex = /^[\u4e00-\u9fff\u0400-\u04ff\s]+$/;
      const isOnlyCjkCyrillic = cjkCyrillicRegex.test(name) && name.length > 0;
      
      if (hasBlacklistedWord || isCoinAlone || isOnlyCjkCyrillic) {
        return null; // Ignorer le token
      }

      return {
        mint,
        name,
        symbol,
        uri: uri || '',
      };
    } catch (error) {
      // Erreur de parsing -> Ignorer le token
      return null;
    }
  }

  /**
   * Décode les métadonnées de token depuis les données base64
   * Format Token Metadata Standard de Solana
   * 
   * NOTE: Le format exact peut varier. On essaie plusieurs offsets possibles.
   */
  private decodeTokenMetadata(base64Data: string): { mint?: string; name?: string; symbol?: string; uri?: string } | null {
    try {
      const buffer = Buffer.from(base64Data, 'base64');
      
      if (buffer.length < 10) return null; // Trop court

      // FORMAT 1: Token Metadata Standard (offset 33-65 = mint)
      // Offset 0-1: discriminator (1 byte)
      // Offset 1-33: update authority (32 bytes)
      // Offset 33-65: mint (32 bytes)
      // Offset 65-69: name length (u32, 4 bytes)
      
      if (buffer.length >= 69) {
        try {
          // Extraire le mint (32 bytes à l'offset 33)
          const mintBytes = buffer.slice(33, 65);
          let mintAddress: string | null = null;
          
          try {
            const publicKey = new PublicKey(mintBytes);
            mintAddress = publicKey.toBase58();
          } catch (error) {
            // Mint invalide, on continue quand même
          }
          
          let offset = 65;
          
          // Lire name
          if (offset + 4 <= buffer.length) {
            const nameLength = buffer.readUInt32LE(offset);
            offset += 4;
            if (offset + nameLength <= buffer.length && nameLength > 0 && nameLength < 1000) {
              const nameBytes = buffer.slice(offset, offset + nameLength);
              const nameStr = nameBytes.toString('utf8').replace(/\0/g, '').trim();
              if (nameStr.length > 0 && /^[\x20-\x7E]+$/.test(nameStr)) { // ASCII printable seulement
                offset += nameLength;
                
                // Lire symbol
                if (offset + 4 <= buffer.length) {
                  const symbolLength = buffer.readUInt32LE(offset);
                  offset += 4;
                  if (offset + symbolLength <= buffer.length && symbolLength > 0 && symbolLength < 100) {
                    const symbolBytes = buffer.slice(offset, offset + symbolLength);
                    const symbolStr = symbolBytes.toString('utf8').replace(/\0/g, '').trim();
                    if (symbolStr.length > 0 && /^[\x20-\x7E]+$/.test(symbolStr)) {
                      offset += symbolLength;
                      
                      // Lire uri
                      let uriStr: string | undefined;
                      if (offset + 4 <= buffer.length) {
                        const uriLength = buffer.readUInt32LE(offset);
                        offset += 4;
                        if (offset + uriLength <= buffer.length && uriLength > 0 && uriLength < 500) {
                          const uriBytes = buffer.slice(offset, offset + uriLength);
                          uriStr = uriBytes.toString('utf8').replace(/\0/g, '').trim();
                        }
                      }
                      
                      // Si on a au moins name et symbol, c'est valide
                      if (nameStr && symbolStr) {
                        return {
                          mint: mintAddress || undefined,
                          name: nameStr,
                          symbol: symbolStr,
                          uri: uriStr,
                        };
                      }
                    }
                  }
                }
              }
            }
          }
        } catch (error) {
          // Format 1 échoué, on essaie le format 2
        }
      }

      // FORMAT 2: Recherche de chaînes UTF-8 valides dans le buffer
      // Parfois les métadonnées sont directement lisibles
      try {
        // Chercher des patterns comme des noms/symboles valides
        // Format possible: texte lisible suivi de null bytes
        const readableParts: string[] = [];
        let currentPart = '';
        
        for (let i = 0; i < Math.min(buffer.length, 500); i++) {
          const char = buffer[i];
          if (char !== undefined && char >= 32 && char <= 126) { // ASCII printable
            currentPart += String.fromCharCode(char);
          } else {
            if (currentPart.length >= 2 && currentPart.length <= 50) {
              readableParts.push(currentPart);
            }
            currentPart = '';
          }
        }
        
        // Prendre les 2-3 premières chaînes valides comme name/symbol
        // Filtrer les artefacts courts comme "cv", "qu", etc.
        const validParts = readableParts.filter(part => {
          const trimmed = part.trim();
          return trimmed.length >= 3 && // Au moins 3 caractères
                 trimmed !== 'cv' && 
                 trimmed !== 'qu' && 
                 trimmed !== '4l' &&
                 /^[\x20-\x7E]+$/.test(trimmed); // ASCII printable seulement
        });
        
        if (validParts.length >= 2) {
          const name = validParts[0]?.trim();
          const symbol = validParts[1]?.trim();
          
          if (name && symbol && name.length >= 3 && name.length <= 50 && symbol.length >= 1 && symbol.length <= 20) {
            return {
              name,
              symbol,
            };
          }
        }
      } catch (error) {
        // Format 2 échoué
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Récupère le mint depuis la transaction via RPC (fallback de sauvetage)
   * Extrait le mint depuis postTokenBalances
   */
  private async recoverMintFromTransaction(signature: string): Promise<string | null> {
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
          { headers: this.prepareRpcHeaders(), timeout: 5000 }
        );

      const transaction = response.data?.result;
      if (!transaction || transaction.meta?.err) {
      return null;
      }

      // Extraire le mint depuis postTokenBalances
      // Le mint est le compte qui a reçu une grosse quantité de tokens et qui n'est pas un programme
      if (transaction.meta.postTokenBalances && Array.isArray(transaction.meta.postTokenBalances)) {
        for (const balance of transaction.meta.postTokenBalances) {
          if (balance.mint && 
              balance.uiTokenAmount?.decimals === 6 && 
              balance.uiTokenAmount?.uiAmount !== null &&
              balance.uiTokenAmount?.uiAmount > 0) {
            // Valider que c'est une adresse Solana valide
            const mint = balance.mint as string;
            if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) && 
                (mint.length === 32 || mint.length === 43 || mint.length === 44)) {
              return mint;
            }
          }
        }
      }

        return null;
    } catch (error) {
      // Erreur silencieuse - on ne veut pas crasher le WebSocket
      return null;
    }
  }

  stop(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.processedSignatures.clear();
    this.recentLogs.clear();
  }
}
