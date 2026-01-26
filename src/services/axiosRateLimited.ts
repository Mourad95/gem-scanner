/**
 * Wrapper axios avec rate limiting global
 * Intercepte toutes les requêtes RPC pour appliquer le rate limiting
 * @module services/axiosRateLimited
 */

import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { rpcRateLimiter } from './rateLimiter.js';

/**
 * Crée une instance axios avec rate limiting automatique
 * Toutes les requêtes POST vers les URLs RPC Solana sont automatiquement limitées
 */
export function createRateLimitedAxios(baseConfig?: AxiosRequestConfig): AxiosInstance {
  const instance = axios.create(baseConfig);

  // Intercepteur de requête : applique le rate limiting
  instance.interceptors.request.use(
    async (config) => {
      // Appliquer le rate limiting uniquement pour les requêtes RPC Solana
      const isRpcRequest = 
        config.url?.includes('helius') ||
        config.url?.includes('solana') ||
        config.url?.includes('rpc') ||
        (config.method === 'post' && config.data?.jsonrpc === '2.0');

      if (isRpcRequest) {
        await rpcRateLimiter.execute(async () => {
          // La fonction est vide car on attend juste le token
          return Promise.resolve();
        });
      }

      return config;
    },
    (error) => {
      return Promise.reject(error);
    }
  );

  // Intercepteur de réponse : gère les erreurs 429 avec backoff
  instance.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        // Appliquer le backoff
        rpcRateLimiter.backoff();
        
        // Ne pas logger les 429 pour éviter le spam
        // Le retry sera géré par le code appelant si nécessaire
      }
      return Promise.reject(error);
    }
  );

  return instance;
}

/**
 * Instance axios globale avec rate limiting pour les appels RPC
 */
export const rateLimitedAxios = createRateLimitedAxios();

