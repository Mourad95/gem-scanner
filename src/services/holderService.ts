/**
 * Service pour récupérer et analyser les holders d'un token Solana
 * Optimisé pour la vélocité pump.fun
 * @module services/holderService
 */

import axios from 'axios';
import type { SolanaConfig } from '../config/settings.js';

/**
 * Données d'un holder
 */
export interface HolderData {
  address: string;
  amount: number; // Montant de tokens détenus
  percentage: number; // Pourcentage de la supply totale (0-100)
}

/**
 * Options pour récupérer les holders
 */
export interface FetchHoldersOptions {
  solana?: SolanaConfig;
  limit?: number; // Nombre de holders à récupérer (défaut: 10)
  signal?: AbortSignal; // Signal d'annulation pour timeout
}

/**
 * 🛡️ ADRESSE OFFICIELLE PUMP.FUN (Bonding Curve)
 * Cette adresse détient la liquidité du token (~80% au lancement) avant la migration Raydium.
 * * CRITIQUE : Elle doit être IMPÉRATIVEMENT exclue de l'analyse des "Top Holders".
 * Sans cette exclusion, le bot détectera faussement une "baleine" possédant 80% 
 * de la supply et déclenchera une alerte "RUG PULL" (Faux Positif).
 */
const PUMP_CURVE_ADDRESS = '6EF8rrecthR5DkZJvT6uS8z6yL7GV8S7Zf4m1G8m7f23';

/**
 * Supply standard d'un token pump.fun (1 Milliard)
 * Utilisé comme fallback pour gagner du temps RPC
 */
const PUMP_FUN_DEFAULT_SUPPLY = 1_000_000_000;

/**
 * Récupère la supply totale d'un token
 * @param {string} tokenAddress - Adresse du token
 * @param {SolanaConfig} solana - Configuration Solana RPC
 * @param {AbortSignal} [signal] - Signal d'annulation
 * @returns {Promise<number>} Supply totale du token
 */
async function fetchTokenSupply(
  tokenAddress: string, 
  solana: SolanaConfig,
  signal?: AbortSignal
): Promise<number> {
  try {
    const response = await axios.post(
      solana.rpcUrl,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'getTokenSupply',
        params: [tokenAddress],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(solana.rpcKey && { Authorization: `Bearer ${solana.rpcKey}` }),
        },
        timeout: 2000, // Timeout court pour la supply
        signal, 
      }
    );

    const supply = response.data?.result?.value?.uiAmount;
    return supply ?? PUMP_FUN_DEFAULT_SUPPLY;
  } catch (error) {
    // En cas d'erreur, on assume la supply standard pump.fun pour ne pas casser l'analyse
    // C'est un compromis "Alpha" : Vitesse > Précision absolue
    return PUMP_FUN_DEFAULT_SUPPLY;
  }
}

/**
 * Récupère la liste des holders d'un token Solana (Top 10 pour performance)
 * @param {string} tokenAddress - Adresse du token
 * @param {FetchHoldersOptions} options - Options de récupération
 * @returns {Promise<HolderData[]>} Liste des holders triés par montant décroissant avec pourcentages
 * @throws {Error} Si la récupération échoue de manière critique
 */
export async function fetchTokenHolders(
  tokenAddress: string,
  options: FetchHoldersOptions = {}
): Promise<HolderData[]> {
  const { solana, limit = 10, signal } = options;

  if (!solana?.rpcUrl) {
    throw new Error('Configuration Solana RPC requise pour récupérer les holders');
  }

  try {
    // 1. Lancement parallèle Supply + Top Accounts
    const [accountsResponse, totalSupply] = await Promise.all([
      axios.post(
        solana.rpcUrl,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenLargestAccounts',
          params: [tokenAddress],
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...(solana.rpcKey && { Authorization: `Bearer ${solana.rpcKey}` }),
          },
          timeout: 2500, // On laisse un peu plus de temps pour les comptes que pour la supply
          signal, 
        }
      ),
      fetchTokenSupply(tokenAddress, solana, signal),
    ]);

    const result = accountsResponse.data?.result;
    
    // Gestion d'erreur RPC spécifique (rate limit ou token invalide)
    if (!result || !result.value) {
      // Si l'erreur vient du RPC, on retourne un tableau vide pour ne pas crasher le bot
      // L'analyzer verra 0 holders et mettra un flag "Warning"
      return [];
    }

    const accounts = result.value;

    // 2. Traitement et Filtrage
    const holders: HolderData[] = accounts
      .map((account: { address: string; amount: string; uiAmount?: number }) => {
        // Fallback si uiAmount est null (arrive parfois sur les mints récents)
        const amount = account.uiAmount ?? (parseFloat(account.amount) / 1e6); // Attention: pump.fun est souvent 6 decimals
        
        // Calcul sécurisé du pourcentage
        const percentage = totalSupply > 0 ? (amount / totalSupply) * 100 : 0;

        return {
          address: account.address,
          amount,
          percentage,
        };
      })
      .filter((holder: HolderData) => holder.address !== PUMP_CURVE_ADDRESS) // Exclure la courbe
      .sort((a: HolderData, b: HolderData) => b.amount - a.amount) // Tri décroissant
      .slice(0, limit); // On coupe après le tri pour avoir les VRAIS top holders

    return holders;
  } catch (error) {
    // Si c'est une annulation volontaire (timeout du scanner), on relance l'erreur
    if (axios.isCancel(error)) {
      throw error;
    }
    
    // Pour les autres erreurs, on log mais on ne crash pas, on retourne vide
    // console.error(`Erreur holders pour ${tokenAddress}:`, error.message);
    return [];
  }
}

/**
 * Calcule les pourcentages de détention pour chaque holder
 * Utile si on veut recalculer après filtrage
 */
export function calculateHolderPercentages(holders: HolderData[], totalSupply: number): HolderData[] {
  if (totalSupply <= 0) return holders.map((h) => ({ ...h, percentage: 0 }));
  return holders.map((holder) => ({
    ...holder,
    percentage: (holder.amount / totalSupply) * 100,
  }));
}

export { PUMP_CURVE_ADDRESS };