/**
 * Service pour récupérer les métadonnées et réserves directement depuis la blockchain Solana
 * VERSION "BULLDOG" : Réessaie jusqu'à trouver les données
 * @module services/blockchainMetadata
 */

import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import type { TokenData } from './analyzer.js';
import type { SolanaConfig } from '../config/settings.js';
import { rpcRateLimiter } from './rateLimiter.js';

/**
 * Constantes des Programmes
 */
const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const PROGRAM_ID = new PublicKey('6EF8rrecthR5DkZJvT6uS8z6yL7GV8S7Zf4m1G8m7f23');

/**
 * Petit utilitaire pour faire une pause
 */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Singleton pour la connexion Solana (une seule instance par configuration)
 * Évite de recréer des connexions à chaque appel
 */
const connectionCache = new Map<string, Connection>();

/**
 * Crée ou récupère une connexion Solana optimisée avec gestion des headers Helius
 * Utilise un cache pour éviter de recréer des connexions
 */
function createConnection(solana: SolanaConfig): Connection {
  // Créer une clé unique pour le cache basée sur l'URL et la clé
  const cacheKey = `${solana.rpcUrl}:${solana.rpcKey || ''}`;
  
  // Si la connexion existe déjà dans le cache, la retourner
  if (connectionCache.has(cacheKey)) {
    return connectionCache.get(cacheKey)!;
  }

  // Si l'URL contient déjà la clé API (format Helius), l'utiliser directement
  const hasApiKeyInUrl = solana.rpcUrl.includes('api-key=') || solana.rpcUrl.includes('apikey=');
  
  // Pour Helius avec clé dans l'URL, utiliser l'URL telle quelle
  // Sinon, ajouter la clé comme header via fetchHeaders
  const fetchHeaders: Record<string, string> = {};
  if (!hasApiKeyInUrl && solana.rpcKey) {
    fetchHeaders['Authorization'] = `Bearer ${solana.rpcKey}`;
  }

  // Créer la connexion avec les headers personnalisés et rate limiting
  const connection = new Connection(solana.rpcUrl, {
    commitment: 'confirmed',
    fetch: async (url, options) => {
      // Appliquer le rate limiting avant chaque requête RPC
      return await rpcRateLimiter.execute(async () => {
        // Fusionner les headers personnalisés avec ceux de la requête
        const mergedHeaders = {
          ...options?.headers,
          ...fetchHeaders,
        };
        
        // Faire la requête
        const response = await fetch(url, { ...options, headers: mergedHeaders });
        
        // Si erreur 429, appliquer la pause globale
        if (response.status === 429) {
          rpcRateLimiter.handle429();
        }
        
        return response;
      });
    },
  });

  // Mettre en cache la connexion
  connectionCache.set(cacheKey, connection);
  return connection;
}

/**
 * Dérive l'adresse des métadonnées (PDA) instantanément en local
 */
function getMetadataAddress(mintAddress: string): string {
  try {
    const mint = new PublicKey(mintAddress);
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('metadata'),
        METAPLEX_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      METAPLEX_PROGRAM_ID
    );
    return pda.toBase58();
  } catch (e) {
    return '';
  }
}

/**
 * Dérive l'adresse de la Bonding Curve pump.fun (PDA)
 * Formule exacte selon la spécification pump.fun
 */
function getBondingCurveAddress(mintAddress: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('bonding-curve'),
      new PublicKey(mintAddress).toBuffer(),
    ],
    PROGRAM_ID
  );
  return pda;
}

function sanitizeString(str: string): string {
  // Enlève les caractères nuls et les caractères non-imprimables bizarres
  return str.replace(/\u0000/g, '').trim();
}

/**
 * Tente de récupérer les métadonnées une fois
 * Utilise Connection de @solana/web3.js pour une meilleure gestion
 */
async function fetchMetadataOnce(
  metadataAccount: string,
  solana: SolanaConfig
): Promise<{ name?: string; symbol?: string; uri?: string } | null> {
  try {
    const connection = createConnection(solana);
    const publicKey = new PublicKey(metadataAccount);
    
    // Utiliser getAccountInfo avec rate limiting pour éviter les 429
    const accountInfo = await rpcRateLimiter.execute(async () => {
      return await Promise.race([
        connection.getAccountInfo(publicKey),
        new Promise<null>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 2000)
        ),
      ]) as { data: Buffer } | null;
    });

    if (!accountInfo || !accountInfo.data) {
      console.log(`   ⚠️  Compte Metaplex non trouvé ou vide: ${metadataAccount.substring(0, 16)}...`);
      return null;
    }

    const buffer = accountInfo.data;
    
    // Vérifier la taille minimale
    if (buffer.length < 65) {
      console.log(`   ⚠️  Données Metaplex trop courtes: ${buffer.length} bytes`);
      return null;
    }
    
    // Structure Metaplex Metadata v1 (selon Stack Exchange):
    // - key (1 byte)
    // - updateAuthority (32 bytes)
    // - mint (32 bytes)
    // - data (struct):
    //   - name (String = u32 length + bytes)
    //   - symbol (String = u32 length + bytes)
    //   - uri (String = u32 length + bytes)
    //   - sellerFeeBasisPoints (u16)
    //   - creators (Option<Vec<Creator>>)
    
    let offset = 65; // Skip Key (1) + UpdateAuth (32) + Mint (32)
    
    // Vérifier qu'on a assez de données pour lire au moins la longueur du name
    if (offset + 4 > buffer.length) {
      console.log(`   ⚠️  Buffer trop court pour lire name length`);
      return null;
    }
    
    // Lire Name
    const nameLen = buffer.readUInt32LE(offset);
    offset += 4;
    
    if (nameLen > 100 || offset + nameLen > buffer.length) {
      console.log(`   ⚠️  Name length invalide: ${nameLen} bytes`);
      return null;
    }
    
    const name = sanitizeString(buffer.slice(offset, offset + nameLen).toString('utf8'));
    offset += nameLen;

    // Lire Symbol
    if (offset + 4 > buffer.length) {
      console.log(`   ⚠️  Buffer trop court pour lire symbol length`);
      return { name: name || undefined, symbol: undefined, uri: undefined };
    }
    
    const symbolLen = buffer.readUInt32LE(offset);
    offset += 4;
    
    if (symbolLen > 20 || offset + symbolLen > buffer.length) {
      console.log(`   ⚠️  Symbol length invalide: ${symbolLen} bytes`);
      return { name: name || undefined, symbol: undefined, uri: undefined };
    }
    
    const symbol = sanitizeString(buffer.slice(offset, offset + symbolLen).toString('utf8'));
    offset += symbolLen;

    // Lire URI
    if (offset + 4 > buffer.length) {
      console.log(`   ⚠️  Buffer trop court pour lire URI length`);
      return { name: name || undefined, symbol: symbol || undefined, uri: undefined };
    }
    
    const uriLen = buffer.readUInt32LE(offset);
    offset += 4;
    
    if (uriLen > 200 || offset + uriLen > buffer.length) {
      console.log(`   ⚠️  URI length invalide: ${uriLen} bytes`);
      return { name: name || undefined, symbol: symbol || undefined, uri: undefined };
    }
    
    const uri = sanitizeString(buffer.slice(offset, offset + uriLen).toString('utf8'));

    if (name || symbol) {
      console.log(`   ✅ Métadonnées Metaplex parsées: name="${name || 'N/A'}", symbol="${symbol || 'N/A'}"`);
    }

    return { name, symbol, uri };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Erreur inconnue';
    console.log(`   ⚠️  Erreur parsing Metaplex: ${errorMsg.substring(0, 100)}`);
    return null;
  }
}

/**
 * Récupère les métadonnées Token2022 directement depuis le compte mint
 * D'après la doc: https://solana.com/docs/tokens/extensions/metadata
 */
async function fetchToken2022Metadata(
  mintAddress: string,
  solana: SolanaConfig
): Promise<{ name?: string; symbol?: string; uri?: string } | null> {
  try {
    const connection = createConnection(solana);
    const mintPublicKey = new PublicKey(mintAddress);
    
    // Utiliser rate limiting pour éviter les 429
    const accountInfo = await rpcRateLimiter.execute(async () => {
      return await Promise.race([
        connection.getAccountInfo(mintPublicKey),
        new Promise<null>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 2000)
        ),
      ]) as { data: Buffer; owner: PublicKey } | null;
    });

    if (!accountInfo || !accountInfo.data) {
      return null;
    }

    // Vérifier si c'est un Token2022 (owner = Token2022 program)
    const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    
    // Accepter Token2022 ou Token standard (certains tokens pump.fun peuvent être Token standard)
    const isTokenProgram = accountInfo.owner.equals(TOKEN_2022_PROGRAM) || accountInfo.owner.equals(TOKEN_PROGRAM);
    if (!isTokenProgram) {
      return null; // Pas un token SPL
    }

    const buffer = accountInfo.data;
    
    // Si c'est un Token standard (pas Token2022), les métadonnées ne sont pas dans le mint
    if (accountInfo.owner.equals(TOKEN_PROGRAM)) {
      return null; // Token standard, utiliser Metaplex
    }
    
    // Structure Token2022 Mint:
    // - Base Mint (165 bytes)
    // - Extensions (variable length)
    //   Chaque extension utilise TLV (Type-Length-Value):
    //   - Extension type (2 bytes u16)
    //   - Extension length (2 bytes u16)
    //   - Extension data
    
    // TokenMetadata extension type = 4 (selon spl-token-2022)
    const TOKEN_METADATA_EXTENSION_TYPE = 4;
    
    // Base Mint size = 82 bytes pour Token2022 (peut varier)
    // On cherche les extensions après les données de base
    let offset = 82; // Base Mint size
    
    if (buffer.length < offset) {
      console.log(`   ⚠️  Buffer Token2022 trop court: ${buffer.length} bytes (attendu au moins ${offset})`);
      return null;
    }
    
    // Log pour debug : afficher le type de programme
    console.log(`   🔍 Mint trouvé: owner=${accountInfo.owner.toBase58().substring(0, 16)}..., taille=${buffer.length} bytes`);
    
    // Parser les extensions TLV et lister toutes les extensions trouvées
    // Note: Les extensions Token2022 utilisent un format différent selon la version
    // Il peut y avoir un header TLV global avant les extensions individuelles
    const foundExtensions: number[] = [];
    
    // Vérifier si c'est un format avec TLV header
    // Certains mints Token2022 ont un header TLV global (2 bytes type + 2 bytes length)
    // avant les extensions individuelles
    
    while (offset < buffer.length - 4) {
      if (offset + 4 > buffer.length) break;
      
      const extensionType = buffer.readUInt16LE(offset);
      offset += 2;
      
      if (offset + 2 > buffer.length) break;
      const extensionLength = buffer.readUInt16LE(offset);
      offset += 2;
      
      // Ignorer les extensions de longueur 0 (probablement du padding ou des erreurs de parsing)
      if (extensionLength === 0) {
        // Peut-être qu'on est dans un format différent, essayer de continuer
        continue;
      }
      
      foundExtensions.push(extensionType);
      
      if (extensionType === TOKEN_METADATA_EXTENSION_TYPE && extensionLength > 0) {
        console.log(`   🔍 Extension TokenMetadata trouvée (type: ${extensionType}, length: ${extensionLength})`);
        // Parser TokenMetadata extension
        // Structure TLV: update_authority (Option<Pubkey>), mint (Pubkey), name, symbol, uri
        let metaOffset = offset;
        
        // Lire update_authority (Option<Pubkey> = 1 byte + 32 bytes si Some)
        if (metaOffset >= buffer.length) break;
        const hasUpdateAuthority = buffer[metaOffset] === 1;
        metaOffset += 1;
        if (hasUpdateAuthority) {
          metaOffset += 32; // Skip Pubkey
        }
        
        // Skip mint (32 bytes)
        if (metaOffset + 32 > buffer.length) break;
        metaOffset += 32;
        
        // Lire name (String = length u32 + bytes)
        if (metaOffset + 4 > buffer.length) break;
        const nameLen = buffer.readUInt32LE(metaOffset);
        metaOffset += 4;
        if (metaOffset + nameLen > buffer.length) break;
        const name = sanitizeString(buffer.slice(metaOffset, metaOffset + nameLen).toString('utf8'));
        metaOffset += nameLen;
        
        // Lire symbol
        if (metaOffset + 4 > buffer.length) break;
        const symbolLen = buffer.readUInt32LE(metaOffset);
        metaOffset += 4;
        if (metaOffset + symbolLen > buffer.length) break;
        const symbol = sanitizeString(buffer.slice(metaOffset, metaOffset + symbolLen).toString('utf8'));
        metaOffset += symbolLen;
        
        // Lire URI
        if (metaOffset + 4 > buffer.length) break;
        const uriLen = buffer.readUInt32LE(metaOffset);
        metaOffset += 4;
        if (metaOffset + uriLen > buffer.length) break;
        const uri = sanitizeString(buffer.slice(metaOffset, metaOffset + uriLen).toString('utf8'));
        
        if (name || symbol) {
          console.log(`   ✅ Métadonnées Token2022 trouvées: name="${name || 'N/A'}", symbol="${symbol || 'N/A'}"`);
          return { name, symbol, uri };
        } else {
          console.log(`   ⚠️  Extension TokenMetadata trouvée mais name/symbol vides`);
        }
      }
      
      offset += extensionLength;
    }
    
    if (foundExtensions.length > 0) {
      console.log(`   ⚠️  Extensions trouvées dans le mint: [${foundExtensions.join(', ')}] (TokenMetadata = ${TOKEN_METADATA_EXTENSION_TYPE})`);
    } else {
      console.log(`   ⚠️  Aucune extension trouvée dans le mint (taille: ${buffer.length} bytes, offset après base: ${offset})`);
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Récupère les métadonnées avec Retry Logic (Le "Bulldog")
 * Essaie d'abord Token2022, puis Metaplex
 */
async function fetchMetaplexMetadataWithRetry(
  mintAddress: string,
  solana: SolanaConfig
): Promise<{ name?: string; symbol?: string; description?: string; image?: string; uri?: string; social?: any } | null> {
  
  // 1. PRIORITÉ : Token2022 Metadata (directement dans le mint)
  let basicMeta = null;
  let attempts = 0;
  const maxAttempts = 3;

  // 🔄 BOUCLE DE RÉ-ESSAI pour Token2022
  while (attempts < maxAttempts) {
    basicMeta = await fetchToken2022Metadata(mintAddress, solana);
    
    // Si on a trouvé le nom, on sort de la boucle !
    if (basicMeta && basicMeta.name) {
      console.log(`   ✅ Métadonnées Token2022 récupérées depuis le mint`);
      break; 
    }

    // Sinon, on attend un peu
    attempts++;
    if (attempts < maxAttempts) {
      await sleep(200 * attempts); 
    }
  }

  // 2. FALLBACK : Metaplex Metadata (PDA externe)
  if (!basicMeta || !basicMeta.name) {
    const metadataAccount = getMetadataAddress(mintAddress);
    if (metadataAccount) {
      console.log(`   🔍 Tentative Metaplex Metadata (PDA: ${metadataAccount.substring(0, 16)}...)`);
      attempts = 0;
      while (attempts < maxAttempts) {
        basicMeta = await fetchMetadataOnce(metadataAccount, solana);
        if (basicMeta && basicMeta.name) {
          console.log(`   ✅ Métadonnées Metaplex récupérées`);
          break;
        }
        attempts++;
        if (attempts < maxAttempts) {
          await sleep(200 * attempts);
        }
      }
    } else {
      console.log(`   ⚠️  PDA Metaplex non dérivable`);
    }
    
    // 3. DERNIER RECOURS : Attendre plus longtemps et réessayer le PDA
    // Les métadonnées peuvent être créées dans une transaction séparée quelques secondes après
    if (!basicMeta || !basicMeta.name) {
      console.log(`   ⏳ Attente supplémentaire (3s) pour laisser le temps aux métadonnées d'être créées...`);
      await sleep(3000);
      
      // Réessayer le PDA Metaplex
      const metadataAccount = getMetadataAddress(mintAddress);
      if (metadataAccount) {
        console.log(`   🔄 Nouvelle tentative Metaplex Metadata après délai...`);
        basicMeta = await fetchMetadataOnce(metadataAccount, solana);
        if (basicMeta && basicMeta.name) {
          console.log(`   ✅ Métadonnées Metaplex récupérées après délai`);
        }
      }
    }
  }

  if (!basicMeta) return null;

  // Enrichissement (JSON off-chain)
  let description: string | undefined;
  let image: string | undefined;
  let social: any = undefined;

  if (basicMeta.uri) {
    try {
      // On essaie d'abord via la gateway Pump.fun (souvent plus rapide pour leurs tokens)
      // Si l'URI est ipfs, on la transforme
      let jsonUrl = basicMeta.uri;
      if (basicMeta.uri.includes('ipfs.io') || basicMeta.uri.includes('pinata')) {
         // Optimisation : utiliser directement l'URI fournie sans passer par une gateway lente si possible
         // Mais pour Pump.fun, l'URI est souvent une URL metadata JSON directe
      }

      const metadataReq = await rpcRateLimiter.execute(async () => {
        try {
          return await axios.get(jsonUrl, { timeout: 1500 });
        } catch (error) {
          // Gérer les erreurs 429
          if (axios.isAxiosError(error) && error.response?.status === 429) {
            rpcRateLimiter.handle429();
          }
          throw error;
        }
      });
      
      const json = metadataReq.data;

      description = json.description;
      image = json.image;
      
      if (json.twitter || json.telegram || json.website) {
        social = {
          twitter: json.twitter,
          telegram: json.telegram,
          website: json.website
        };
      }
    } catch (e) {
      // Fail silencieux sur le JSON, mais on garde le nom/symbol !
    }
  }

  return { 
    name: basicMeta.name, 
    symbol: basicMeta.symbol, 
    uri: basicMeta.uri, 
    description, 
    image, 
    social 
  };
}

/**
 * Récupère les réserves réelles de la Bonding Curve
 * Utilise Connection de @solana/web3.js avec retry loop robuste
 * @export pour utilisation dans solanaMonitor.ts
 */
export async function fetchBondingCurveReserves(
  mintAddress: string,
  solana: SolanaConfig
): Promise<{ vSolReserves: number; tokenReserves: number } | null> {
  try {
    // 1. Calcul PDA Robuste avec la formule exacte
    const curvePublicKey = getBondingCurveAddress(mintAddress);
    const curveAddress = curvePublicKey.toBase58();
    console.log(`   🔍 Bonding curve PDA: ${curveAddress} (mint: ${mintAddress.substring(0, 16)}...)`);

    const connection = createConnection(solana);
    
    // 2. Retry Loop (La Tenacité) - 3 tentatives
    let accountInfo: { data: Buffer } | null = null;
    const maxAttempts = 3;
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Utiliser 'processed' pour la première tentative (plus rapide), puis 'confirmed'
        const commitment = attempt === 0 ? 'processed' : 'confirmed';
        
        accountInfo = await rpcRateLimiter.execute(async () => {
          return await Promise.race([
            connection.getAccountInfo(curvePublicKey, { commitment }),
            new Promise<null>((_, reject) => 
              setTimeout(() => reject(new Error('Timeout')), 3000)
            ),
          ]) as { data: Buffer } | null;
        });

        // Si on a trouvé le compte, sortir de la boucle
        if (accountInfo && accountInfo.data) {
          console.log(`   ✅ Bonding curve trouvée à la tentative ${attempt + 1}/${maxAttempts} (commitment: ${commitment})`);
          break;
        }

        // Si ce n'est pas la dernière tentative, attendre 500ms
        if (attempt < maxAttempts - 1) {
          await sleep(500);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Erreur inconnue';
        if (attempt < maxAttempts - 1) {
          console.log(`   ⚠️  Tentative ${attempt + 1}/${maxAttempts} échouée: ${errorMsg.substring(0, 50)}`);
          await sleep(500);
          continue;
        }
        // Dernière tentative échouée, on sortira avec accountInfo = null
        console.log(`   ⚠️  Dernière tentative échouée: ${errorMsg.substring(0, 50)}`);
      }
    }

    // Si le compte n'existe toujours pas après 3 tentatives, retourner null
    // (ne pas retourner les valeurs par défaut qui masquent le problème)
    if (!accountInfo || !accountInfo.data) {
      console.log(`   ⚠️  Bonding curve non trouvée après ${maxAttempts} tentatives (PDA: ${curveAddress})`);
      return null;
    }

    const buffer = accountInfo.data;
    
    // 3. Décodage correct des offsets
    // Structure Pump.fun Bonding Curve:
    // - discriminator: 8 bytes (offset 0-7)
    // - virtualTokenReserves: 8 bytes uint64 (offset 8-15)
    // - virtualSolReserves: 8 bytes uint64 (offset 16-23)
    
    if (buffer.length < 24) {
      console.log(`   ⚠️  Buffer bonding curve trop court: ${buffer.length} bytes (attendu au moins 24)`);
      return null;
    }

    // Lire virtualTokenReserves (uint64, offset 8)
    const virtualTokenReservesRaw = buffer.readBigUInt64LE(8);
    const virtualTokenReserves = Number(virtualTokenReservesRaw) / 1e6; // Diviser par 1e6 car decimals = 6

    // Lire virtualSolReserves (uint64, offset 16)
    const virtualSolReservesRaw = buffer.readBigUInt64LE(16);
    const virtualSolReserves = Number(virtualSolReservesRaw) / 1e9; // Diviser par 1e9 car SOL a 9 decimals

    // Logue les valeurs lues
    console.log(`   ✅ Curve lue: ${virtualSolReserves.toFixed(2)} SOL / ${virtualTokenReserves.toFixed(0)} Tokens`);

    return {
      vSolReserves: virtualSolReserves,
      tokenReserves: virtualTokenReserves
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Erreur inconnue';
    console.log(`   ⚠️  Erreur lors de la récupération de la bonding curve: ${errorMsg.substring(0, 100)}`);
    return null;
  }
}

/**
 * Point d'entrée principal pour l'enrichissement
 * @param existingMetadata - Métadonnées existantes (name, symbol) venant des logs. Si fournies, on skip Metaplex.
 */
export async function fetchTokenDataFromBlockchain(
  mintAddress: string,
  solana: SolanaConfig,
  existingMetadata?: { name?: string; symbol?: string }
): Promise<Partial<TokenData> | null> {
  try {
    console.log(`   🔗 Récupération depuis la blockchain Solana...`);
    
    // 4. Optimisation Metaplex : Si on a déjà name et symbol, NE PAS appeler Metaplex
    let metadata: { name?: string; symbol?: string; description?: string; image?: string; uri?: string; social?: any } | null = null;
    
    if (existingMetadata?.name && existingMetadata?.symbol) {
      // On a déjà les métadonnées de base depuis les logs, on skip Metaplex
      console.log(`   ⚡ Métadonnées déjà disponibles (name: ${existingMetadata.name}, symbol: ${existingMetadata.symbol}), skip Metaplex`);
      metadata = {
        name: existingMetadata.name,
        symbol: existingMetadata.symbol,
        // On peut quand même essayer de récupérer description/image via URI si nécessaire
        // mais pour l'instant on garde juste name/symbol pour gagner du temps
      };
    } else {
      // On n'a pas les métadonnées, on les récupère via Metaplex
      metadata = await fetchMetaplexMetadataWithRetry(mintAddress, solana);
    }
    
    // Récupérer les réserves en parallèle (toujours nécessaire)
    const reserves = await fetchBondingCurveReserves(mintAddress, solana);

    if (!metadata && !reserves) return null;

    const tokenData: Partial<TokenData> = {
      address: mintAddress,
      metadata: metadata ? {
        name: metadata.name,
        symbol: metadata.symbol,
        description: metadata.description,
        image: metadata.image,
        social: metadata.social
      } : undefined,
      reserves: reserves || undefined,
    };

    if (tokenData.metadata?.name) {
       console.log(`   ✅ Données récupérées depuis la blockchain`);
       console.log(`      Nom: ${tokenData.metadata.name}, Symbol: ${tokenData.metadata.symbol || 'N/A'}`);
       if (tokenData.reserves) {
         console.log(`      Réserves: ${tokenData.reserves.vSolReserves.toFixed(2)} SOL, ${tokenData.reserves.tokenReserves.toFixed(0)} tokens`);
       }
    } else if (tokenData.reserves) {
       console.log(`   ✅ Réserves récupérées depuis la blockchain`);
       console.log(`      Réserves: ${tokenData.reserves.vSolReserves.toFixed(2)} SOL, ${tokenData.reserves.tokenReserves.toFixed(0)} tokens`);
    }

    return tokenData;
  } catch (error) {
    return null;
  }
}