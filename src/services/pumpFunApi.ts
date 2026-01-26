/**
 * Service pour récupérer les nouveaux tokens depuis l'API REST de pump.fun
 * @module services/pumpFunApi
 */

import axios, { type AxiosInstance } from 'axios';
import type { TokenData } from './analyzer.js';

/**
 * Interface pour les données brutes d'un token depuis l'API pump.fun
 */
interface PumpFunTokenResponse {
  mint: string;
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  virtualSolReserves?: number;
  virtualTokenReserves?: number;
  freeMint?: boolean;
  devHolding?: number;
  created_timestamp?: number;
}

/**
 * Client API pour pump.fun
 */
class PumpFunApiClient {
  private client: AxiosInstance;
  private lastCheckedTimestamp: number = 0;
  private processedTokens: Set<string> = new Set();

  private baseUrls: string[] = [
    'https://api.pump.fun',
    'https://pump.fun/api',
    'https://www.pump.fun/api',
  ];

  constructor() {
    this.client = axios.create({
      baseURL: this.baseUrls[0],
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });
  }

  /**
   * Récupère les nouveaux tokens depuis l'API pump.fun
   * @param {number} limit - Nombre de tokens à récupérer (max 50)
   * @returns {Promise<TokenData[]>} Liste des nouveaux tokens
   */
  async getNewTokens(limit: number = 20): Promise<TokenData[]> {
    try {
      // Essayer différentes URLs et endpoints
      const endpoints = [
        { path: '/coins', params: { limit, offset: 0, sort: 'created_timestamp', order: 'desc' } },
        { path: '/tokens', params: { limit, offset: 0, sort: 'created_timestamp', order: 'desc' } },
        { path: '/api/coins', params: { limit, offset: 0, sort: 'created_timestamp', order: 'desc' } },
        { path: '/v1/coins', params: { limit, offset: 0, sort: 'created_timestamp', order: 'desc' } },
      ];

      let response;
      let lastError: Error | null = null;

      // Essayer chaque URL
      for (let urlIndex = 0; urlIndex < this.baseUrls.length; urlIndex++) {
        this.client.defaults.baseURL = this.baseUrls[urlIndex];
        
        // Essayer chaque endpoint pour cette URL
        for (const endpoint of endpoints) {
          try {
            response = await this.client.get<PumpFunTokenResponse[]>(endpoint.path, {
              params: endpoint.params,
            });
            
            // Si on a une réponse valide, sortir de toutes les boucles
            if (response && response.status === 200 && Array.isArray(response.data) && response.data.length > 0) {
              break;
            }
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            continue;
          }
        }
        
        // Si on a trouvé une réponse valide, sortir
        if (response && response.status === 200 && Array.isArray(response.data)) {
          break;
        }
      }

      // Si aucune requête n'a fonctionné
      if (!response || !response.data || !Array.isArray(response.data)) {
        const errorMsg = lastError 
          ? (lastError.message || 'Erreur inconnue')
          : 'Aucune API pump.fun accessible';
        throw new Error(errorMsg);
      }

      const tokens = response.data || [];
      const now = Date.now();
      
      // Filtrer uniquement les tokens créés après le dernier check
      const newTokens = tokens
        .filter((token) => {
          if (!token.mint) return false;
          
          // Ignorer les tokens déjà traités
          if (this.processedTokens.has(token.mint)) return false;
          
          // Si c'est le premier check, prendre uniquement les tokens très récents (< 2 minutes)
          if (this.lastCheckedTimestamp === 0) {
            const tokenAge = now - (token.created_timestamp ? token.created_timestamp * 1000 : 0);
            return tokenAge < 120000; // 2 minutes
          }
          
          // Sinon, prendre les tokens créés après le dernier check
          const tokenTimestamp = token.created_timestamp ? token.created_timestamp * 1000 : 0;
          return tokenTimestamp > this.lastCheckedTimestamp;
        })
        .map((token) => this.convertToTokenData(token));

      // Mettre à jour le timestamp du dernier check
      this.lastCheckedTimestamp = now;

      // Marquer les tokens comme traités
      newTokens.forEach((token) => {
        if (token.address) {
          this.processedTokens.add(token.address);
        }
      });

      return newTokens;
    } catch (error) {
      // Ne pas logger tout l'objet d'erreur, juste le message
      const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
      const axiosError = error as any;
      const statusCode = axiosError?.response?.status;
      const statusText = axiosError?.response?.statusText;
      
      if (statusCode === 530 || statusCode === 1016) {
        // Erreur Cloudflare DNS - l'API n'est probablement pas accessible publiquement
        console.error(`❌ API pump.fun inaccessible (DNS error ${statusCode}). L'API publique n'est peut-être pas disponible.`);
        console.error(`   💡 Suggestion: Utilisez une autre source de données ou surveillez directement les transactions Solana.`);
      } else if (statusCode) {
        console.error(`❌ Erreur API pump.fun (${statusCode} ${statusText || ''}): ${errorMessage}`);
      } else {
        console.error(`❌ Erreur API pump.fun: ${errorMessage}`);
      }
      
      return [];
    }
  }

  /**
   * Convertit une réponse de l'API pump.fun en TokenData
   * @param {PumpFunTokenResponse} token - Token depuis l'API
   * @returns {TokenData} TokenData formaté
   */
  private convertToTokenData(token: PumpFunTokenResponse): TokenData {
    return {
      address: token.mint,
      freeMint: token.freeMint,
      devHolding: token.devHolding,
      metadata: {
        name: token.name,
        symbol: token.symbol,
        description: token.description,
        image: token.image,
        social: {
          twitter: token.twitter,
          telegram: token.telegram,
          website: token.website,
        },
      },
      reserves: {
        vSolReserves: token.virtualSolReserves || 0,
        tokenReserves: token.virtualTokenReserves || 0,
      },
    };
  }

  /**
   * Réinitialise le cache des tokens traités (utile pour les tests)
   */
  resetCache(): void {
    this.processedTokens.clear();
    this.lastCheckedTimestamp = 0;
  }
}

// Instance singleton
let apiClient: PumpFunApiClient | null = null;

/**
 * Obtient l'instance du client API pump.fun
 * @returns {PumpFunApiClient} Instance du client
 */
export function getPumpFunApiClient(): PumpFunApiClient {
  if (!apiClient) {
    apiClient = new PumpFunApiClient();
  }
  return apiClient;
}

/**
 * Récupère les nouveaux tokens depuis pump.fun
 * @param {number} limit - Nombre de tokens à récupérer
 * @returns {Promise<TokenData[]>} Liste des nouveaux tokens
 */
export async function fetchNewPumpFunTokens(limit: number = 20): Promise<TokenData[]> {
  const client = getPumpFunApiClient();
  return client.getNewTokens(limit);
}

