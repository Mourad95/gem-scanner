/**
 * Service d'analyse et de validation de tokens Solana
 * @module services/analyzer
 */

import axios from 'axios';
import type { HolderData } from './holderService.js';
import { PUMP_CURVE_ADDRESS } from './holderService.js';

/**
 * Informations sociales du token
 */
export interface TokenSocial {
  twitter?: string;
  telegram?: string;
  website?: string;
}

/**
 * Métadonnées du token
 */
export interface TokenMetadata {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  social?: TokenSocial;
}

/**
 * Réserves et informations financières du token
 */
export interface TokenReserves {
  vSolReserves: number; // Réserves en SOL virtuelles
  tokenReserves: number; // Réserves de tokens (vTokenReserves)
}

/**
 * Données complètes d'un token
 */
export interface TokenData {
  address: string;
  freeMint?: boolean;
  devHolding?: number; // Pourcentage de détention du développeur (0-100)
  metadata?: TokenMetadata;
  reserves?: TokenReserves;
  [key: string]: unknown; // Permet d'accepter d'autres propriétés
}

/**
 * Résultat de l'analyse d'un token
 */
export interface TokenAnalysisResult {
  score: number; // Score de 0 à 100
  isAlphaAlert: boolean; // True si score > 70
  marketCap: number; // Market Cap calculé en USD
  bondingCurveProgress: number; // Progrès de la bonding curve (0-100)
  breakdown: {
    socialScore: number;
    bondingCurveScore: number;
    antiRugScore: number;
    devHoldingPenalty: number;
    holdersScore: number; // Score de distribution des holders (Shadow Scan)
  };
  reasons: string[]; // Raisons du score
}

/**
 * Options pour la validation du token
 */
export interface ValidateTokenOptions {
  solPriceUsd?: number; // Prix du SOL en USD (si non fourni, sera récupéré via API)
  holders?: HolderData[]; // Liste des holders (si non fourni, sera récupéré via holderService)
  devAddress?: string; // Adresse officielle du développeur (pour exclure du check de concentration)
}

/**
 * Constantes pour les calculs pump.fun
 */
const PUMP_FUN_BONDING_CURVE_START = 30; // SOL
const PUMP_FUN_BONDING_CURVE_END = 85; // SOL
const PUMP_FUN_BONDING_CURVE_RANGE = PUMP_FUN_BONDING_CURVE_END - PUMP_FUN_BONDING_CURVE_START; // 55 SOL
const PUMP_FUN_TOTAL_SUPPLY = 1_000_000_000; // 1 milliard de tokens

/**
 * Seuils pour le scoring
 */
const BONDING_CURVE_ALPHA_MIN = 15; // Zone alpha commence à 15%
const BONDING_CURVE_ALPHA_MAX = 60; // Zone alpha se termine à 60%
const BONDING_CURVE_RISK_THRESHOLD = 80; // Au-delà de 80%, risque de dump
const DEV_HOLDING_MAX = 10; // Si dev > 10%, pénalité
const DEV_HOLDING_PENALTY = 50; // Pénalité si dev > 10%
const ALPHA_ALERT_THRESHOLD = 70;

/**
 * Seuils pour l'analyse des holders
 */
const HOLDERS_TOP10_MAX = 30; // Si Top 10 > 30%, pénalité lourde
const HOLDERS_TOP10_GOOD = 15; // Si Top 10 < 15%, bonne distribution
const HOLDERS_SINGLE_WALLET_MAX = 10; // Si un seul wallet > 10%, pénalité critique
const HOLDERS_TOP10_PENALTY = 40; // Pénalité si Top 10 > 30%
const HOLDERS_SINGLE_WALLET_PENALTY = 50; // Pénalité si un wallet > 10%

/**
 * Points attribués pour chaque critère
 * Rééquilibré pour que le Shadow Scan (holders) pèse 40% de la note finale
 */
const SCORING = {
  SOCIAL_PRESENCE: 15, // Twitter ET Telegram présents (vérifiés) - réduit de 40 à 15
  BONDING_CURVE_ALPHA: 12, // Zone alpha (15-60%) - réduit de 30 à 12
  BONDING_CURVE_GOOD: 6, // Zone acceptable (5-15% ou 60-80%) - réduit de 15 à 6
  ANTI_RUG: 15, // freeMint false + metadata cohérentes + liens valides - réduit de 40 à 15
  HOLDERS_EXCELLENT: 40, // Excellente distribution (Top 10 < 15%) - Shadow Scan 40%
  HOLDERS_GOOD: 20, // Bonne distribution (Top 10 < 30%) - Shadow Scan 40%
} as const;

/**
 * Cache pour le prix du SOL (évite trop d'appels API)
 */
let cachedSolPrice: number | null = null;
let cacheTimestamp: number = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Récupère le prix actuel du SOL via CoinGecko
 * @returns {Promise<number>} Prix du SOL en USD
 * @throws {Error} Si la récupération échoue
 */
export async function fetchSolPrice(): Promise<number> {
  // Vérifier le cache
  const now = Date.now();
  if (cachedSolPrice !== null && now - cacheTimestamp < CACHE_DURATION) {
    return cachedSolPrice;
  }

  try {
    const response = await axios.get<{
      solana: { usd: number };
    }>('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: 'solana',
        vs_currencies: 'usd',
      },
      timeout: 5000,
    });

    const price = response.data.solana?.usd;
    if (!price || price <= 0) {
      throw new Error('Prix SOL invalide depuis CoinGecko');
    }

    cachedSolPrice = price;
    cacheTimestamp = now;
    return price;
  } catch (error) {
    // Si le cache existe, utiliser la valeur en cache même si expirée
    if (cachedSolPrice !== null) {
      return cachedSolPrice;
    }

    // Fallback si pas de cache et erreur API
    throw new Error(
      `Impossible de récupérer le prix SOL: ${error instanceof Error ? error.message : 'Erreur inconnue'}`
    );
  }
}

/**
 * Vérifie si un lien Twitter est valide
 * @param {string} url - URL à vérifier
 * @returns {boolean} True si le lien est valide
 */
function isValidTwitterLink(url: string): boolean {
  // Regex pour Twitter/X : https://twitter.com/... ou https://x.com/...
  const twitterRegex = /^https?:\/\/(www\.)?(twitter\.com|x\.com)\/[a-zA-Z0-9_]+/i;
  return twitterRegex.test(url);
}

/**
 * Vérifie si un lien Telegram est valide
 * @param {string} url - URL à vérifier
 * @returns {boolean} True si le lien est valide
 */
function isValidTelegramLink(url: string): boolean {
  // Regex pour Telegram : https://t.me/... ou https://telegram.me/...
  const telegramRegex = /^https?:\/\/(t\.me|telegram\.me)\/[a-zA-Z0-9_]+/i;
  return telegramRegex.test(url);
}

/**
 * Calcule le progrès de la bonding curve pump.fun
 * Formule : progress = ((vSolReserves - 30) / (85 - 30)) * 100
 * @param {TokenReserves} reserves - Réserves du token
 * @returns {number} Progrès de la bonding curve (0-100)
 */
export function calculateBondingCurveProgress(reserves?: TokenReserves): number {
  if (!reserves || reserves.vSolReserves < PUMP_FUN_BONDING_CURVE_START) {
    return 0;
  }

  if (reserves.vSolReserves >= PUMP_FUN_BONDING_CURVE_END) {
    return 100; // Bonding curve terminée
  }

  // Formule pump.fun : progress = ((vSolReserves - 30) / (85 - 30)) * 100
  const progress = ((reserves.vSolReserves - PUMP_FUN_BONDING_CURVE_START) / PUMP_FUN_BONDING_CURVE_RANGE) * 100;

  return Math.max(0, Math.min(100, progress));
}

/**
 * Calcule le Market Cap précis selon la formule pump.fun
 * Formule : (vSolReserves / vTokenReserves) * 1,000,000,000 * currentSolPrice
 * @param {TokenReserves} reserves - Réserves du token
 * @param {number} solPriceUsd - Prix du SOL en USD
 * @returns {number} Market Cap en USD
 */
export function calculateMarketCap(reserves?: TokenReserves, solPriceUsd: number = 100): number {
  if (!reserves || reserves.vSolReserves <= 0 || reserves.tokenReserves <= 0) {
    return 0;
  }

  // Formule pump.fun : (vSolReserves / vTokenReserves) * 1,000,000,000 * currentSolPrice
  const marketCap = (reserves.vSolReserves / reserves.tokenReserves) * PUMP_FUN_TOTAL_SUPPLY * solPriceUsd;

  return Math.max(0, marketCap);
}

/**
 * Vérifie la présence sociale du token avec validation des liens
 * @param {TokenMetadata} metadata - Métadonnées du token
 * @returns {number} Score de présence sociale (0 ou 40)
 */
function evaluateSocialPresence(metadata?: TokenMetadata): number {
  if (!metadata?.social) {
    return 0;
  }

  const { twitter, telegram } = metadata.social;

  // Les deux doivent être présents ET valides pour obtenir les points
  if (twitter && telegram) {
    const twitterValid = isValidTwitterLink(twitter);
    const telegramValid = isValidTelegramLink(telegram);

    if (twitterValid && telegramValid) {
      return SCORING.SOCIAL_PRESENCE;
    }
  }

  return 0;
}

/**
 * Évalue la bonding curve du token avec les nouvelles règles
 * @param {TokenReserves} reserves - Réserves du token
 * @returns {number} Score de bonding curve (0 à 30)
 */
function evaluateBondingCurve(reserves?: TokenReserves): number {
  if (!reserves) {
    return 0;
  }

  const progress = calculateBondingCurveProgress(reserves);

  // Zone Alpha : 15% à 60% → Score maximum
  if (progress >= BONDING_CURVE_ALPHA_MIN && progress <= BONDING_CURVE_ALPHA_MAX) {
    return SCORING.BONDING_CURVE_ALPHA;
  }

  // Zone acceptable : 5-15% ou 60-80% → Score moyen
  if ((progress >= 5 && progress < BONDING_CURVE_ALPHA_MIN) || (progress > BONDING_CURVE_ALPHA_MAX && progress <= BONDING_CURVE_RISK_THRESHOLD)) {
    return SCORING.BONDING_CURVE_GOOD;
  }

  // Au-delà de 80% : Risque de dump à la migration → Score réduit
  if (progress > BONDING_CURVE_RISK_THRESHOLD) {
    return Math.max(0, SCORING.BONDING_CURVE_GOOD - 10); // Pénalité de 10 points
  }

  // En dessous de 5% : Trop tôt
  return 0;
}

/**
 * Évalue les mesures anti-rug du token
 * @param {TokenData} token - Données du token
 * @returns {number} Score anti-rug (0 à 40)
 */
function evaluateAntiRug(token: TokenData): number {
  let score = 0;

  // Vérification freeMint : si false ou non défini (considéré comme sécurisé)
  if (token.freeMint === false || token.freeMint === undefined) {
    score += 20;
  }

  // Vérification de la cohérence des métadonnées
  const metadata = token.metadata;
  if (metadata) {
    const hasName = Boolean(metadata.name && metadata.name.trim().length > 0);
    const hasSymbol = Boolean(metadata.symbol && metadata.symbol.trim().length > 0);
    const hasDescription = Boolean(metadata.description && metadata.description.trim().length > 0);
    const hasImage = Boolean(metadata.image);

    // Si toutes les métadonnées essentielles sont présentes
    if (hasName && hasSymbol && hasDescription && hasImage) {
      score += 20;
    } else if (hasName && hasSymbol) {
      // Au moins les métadonnées de base
      score += 10;
    }

    // Vérification des liens sociaux (déjà fait dans evaluateSocialPresence mais on peut ajouter des points ici)
    if (metadata.social) {
      const { twitter, telegram } = metadata.social;
      if (twitter && isValidTwitterLink(twitter) && telegram && isValidTelegramLink(telegram)) {
        // Les liens sont déjà comptés dans socialScore, mais on peut ajouter un bonus anti-rug
        score += 5;
      }
    }
  }

  return Math.min(score, SCORING.ANTI_RUG);
}

/**
 * Évalue la détention du développeur et applique une pénalité si nécessaire
 * @param {TokenData} token - Données du token
 * @returns {number} Pénalité appliquée (0 ou -50)
 */
function evaluateDevHolding(token: TokenData): number {
  if (token.devHolding === undefined || token.devHolding === null) {
    return 0; // Pas d'information disponible, pas de pénalité
  }

  if (token.devHolding > DEV_HOLDING_MAX) {
    return -DEV_HOLDING_PENALTY; // Pénalité de -50 points
  }

  return 0;
}

/**
 * Évalue la distribution des holders (Shadow Scan)
 * @param {HolderData[]} holders - Liste des holders
 * @param {string} devAddress - Adresse officielle du développeur (optionnelle)
 * @returns {number} Score de distribution (-50 à +40)
 */
function evaluateHolders(holders: HolderData[], devAddress?: string): number {
  if (!holders || holders.length === 0) {
    return 0; // Pas de données disponibles
  }

  // Filtrer l'adresse de la bonding curve pump.fun
  const realHolders = holders.filter((h) => h.address !== PUMP_CURVE_ADDRESS);

  if (realHolders.length === 0) {
    return 0;
  }

  // Calculer le pourcentage total détenu par le Top 10
  const top10Holders = realHolders.slice(0, 10);
  const top10Percentage = top10Holders.reduce((acc, curr) => acc + curr.percentage, 0);

  // Vérifier si un seul wallet (hors dev) possède > 10%
  const singleWalletRisk = realHolders.find((holder) => {
    // Exclure le dev officiel si son adresse est fournie
    if (devAddress && holder.address === devAddress) {
      return false;
    }
    return holder.percentage > HOLDERS_SINGLE_WALLET_MAX;
  });

  // Pénalité critique : un seul wallet > 10%
  if (singleWalletRisk) {
    return -HOLDERS_SINGLE_WALLET_PENALTY; // -50 points
  }

  // Pénalité lourde : Top 10 > 30%
  if (top10Percentage > HOLDERS_TOP10_MAX) {
    return -HOLDERS_TOP10_PENALTY; // -40 points
  }

  // Bonne distribution : Top 10 < 15%
  if (top10Percentage < HOLDERS_TOP10_GOOD) {
    return SCORING.HOLDERS_EXCELLENT; // +40 points
  }

  // Distribution acceptable : Top 10 entre 15% et 30%
  return SCORING.HOLDERS_GOOD; // +20 points
}

/**
 * Valide un token et retourne un score de 0 à 100
 * @param {TokenData} token - Données du token à analyser
 * @param {ValidateTokenOptions} options - Options de validation (prix SOL, etc.)
 * @returns {Promise<TokenAnalysisResult>} Résultat de l'analyse avec score et détails
 */
export async function validateToken(
  token: TokenData,
  options: ValidateTokenOptions = {}
): Promise<TokenAnalysisResult> {
  const reasons: string[] = [];
  let totalScore = 0;

  // Récupérer le prix du SOL
  let solPriceUsd = options.solPriceUsd;
  if (!solPriceUsd) {
    try {
      solPriceUsd = await fetchSolPrice();
    } catch (error) {
      // Fallback sur un prix par défaut si l'API échoue
      solPriceUsd = 100;
      reasons.push('⚠️ Prix SOL par défaut utilisé (API indisponible)');
    }
  }

  // Évaluation de la présence sociale
  const socialScore = evaluateSocialPresence(token.metadata);
  totalScore += socialScore;
  if (socialScore > 0) {
    reasons.push('✅ Présence sociale complète (Twitter + Telegram vérifiés)');
  } else {
    const social = token.metadata?.social;
    if (social?.twitter || social?.telegram) {
      reasons.push('⚠️ Présence sociale incomplète ou liens invalides');
    } else {
      reasons.push('❌ Présence sociale absente');
    }
  }

  // Évaluation de la bonding curve
  const bondingCurveScore = evaluateBondingCurve(token.reserves);
  totalScore += bondingCurveScore;
  const progress = calculateBondingCurveProgress(token.reserves);
  
  if (progress >= BONDING_CURVE_ALPHA_MIN && progress <= BONDING_CURVE_ALPHA_MAX) {
    reasons.push(`✅ Bonding curve en zone Alpha (${progress.toFixed(2)}%)`);
  } else if (progress > BONDING_CURVE_RISK_THRESHOLD) {
    reasons.push(`⚠️ Bonding curve à risque (${progress.toFixed(2)}% - risque de dump)`);
  } else if (progress > 0) {
    reasons.push(`📊 Bonding curve acceptable (${progress.toFixed(2)}%)`);
  } else {
    reasons.push('❌ Bonding curve non disponible ou trop tôt');
  }

  // Évaluation anti-rug
  const antiRugScore = evaluateAntiRug(token);
  totalScore += antiRugScore;
  if (antiRugScore >= SCORING.ANTI_RUG) {
    reasons.push('✅ Mesures anti-rug complètes');
  } else if (antiRugScore >= SCORING.ANTI_RUG / 2) {
    reasons.push('⚠️ Mesures anti-rug partielles');
  } else {
    reasons.push('❌ Mesures anti-rug insuffisantes');
  }

  // Évaluation de la détention du développeur
  const devHoldingPenalty = evaluateDevHolding(token);
  totalScore += devHoldingPenalty;
  if (devHoldingPenalty < 0) {
    reasons.push(`🚨 Pénalité: Détention développeur trop élevée (${token.devHolding}% > ${DEV_HOLDING_MAX}%)`);
  } else if (token.devHolding !== undefined) {
    reasons.push(`✅ Détention développeur acceptable (${token.devHolding}%)`);
  }

  // Évaluation de la distribution des holders (Shadow Scan - 40% du score)
  let holdersScore = 0;
  let holders: HolderData[] | undefined = options.holders;

  // Si les holders ne sont pas fournis, essayer de les récupérer
  // Note: En production, vous devriez toujours fournir les holders via options
  // pour éviter les appels API supplémentaires
  if (!holders) {
    // Les holders devront être récupérés par l'appelant via holderService
    // Pour l'instant, on continue sans pénalité si non disponibles
    reasons.push('⚠️ Analyse des holders non disponible (Shadow Scan ignoré)');
  } else {
    holdersScore = evaluateHolders(holders, options.devAddress);

    // Calculer le Top 10 pour les messages
    const realHolders = holders.filter((h) => h.address !== PUMP_CURVE_ADDRESS);
    const top10Holders = realHolders.slice(0, 10);
    const top10Percentage = top10Holders.reduce((acc, curr) => acc + curr.percentage, 0);

    if (holdersScore === -HOLDERS_SINGLE_WALLET_PENALTY) {
      const riskyHolder = realHolders.find(
        (h) => h.percentage > HOLDERS_SINGLE_WALLET_MAX && h.address !== options.devAddress
      );
      reasons.push(
        `🚨 CRITIQUE: Un wallet détient ${riskyHolder?.percentage.toFixed(2)}% (risque de dump massif)`
      );
    } else if (holdersScore === -HOLDERS_TOP10_PENALTY) {
      reasons.push(
        `🚨 Pénalité: Top 10 détient ${top10Percentage.toFixed(2)}% (concentration trop élevée)`
      );
    } else if (holdersScore === SCORING.HOLDERS_EXCELLENT) {
      reasons.push(
        `✅ Excellente distribution: Top 10 détient ${top10Percentage.toFixed(2)}% (Shadow Scan optimal)`
      );
    } else if (holdersScore === SCORING.HOLDERS_GOOD) {
      reasons.push(
        `✅ Bonne distribution: Top 10 détient ${top10Percentage.toFixed(2)}% (Shadow Scan acceptable)`
      );
    }
  }

  totalScore += holdersScore;

  // Calcul du Market Cap
  const marketCap = calculateMarketCap(token.reserves, solPriceUsd);

  // Détermination si c'est une Alerte Alpha
  const isAlphaAlert = totalScore > ALPHA_ALERT_THRESHOLD;
  if (isAlphaAlert) {
    reasons.push('🚨 ALERTE ALPHA DÉTECTÉE 🚨');
  }

  return {
    score: Math.min(100, Math.max(0, totalScore)), // S'assure que le score est entre 0 et 100
    isAlphaAlert,
    marketCap,
    bondingCurveProgress: progress,
    breakdown: {
      socialScore,
      bondingCurveScore,
      antiRugScore,
      devHoldingPenalty,
      holdersScore,
    },
    reasons,
  };
}
