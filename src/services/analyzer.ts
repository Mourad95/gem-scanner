/**
 * Service d'analyse et de validation de tokens Solana
 * STRATÉGIE "MOMENTUM / GEMS" : Basée sur la traction réelle
 * On ne récompense plus la nouveauté, mais la survie et le momentum
 * @module services/analyzer
 */

import axios from 'axios';
import type { HolderData } from './holderService.js';
import { PUMP_CURVE_ADDRESS } from './holderService.js';
import { analyzeTokenSemantics } from './aiService.js';

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
    holdersScore: number; // Score de distribution des holders
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
 * Seuils financiers critiques (MODE "MOMENTUM / GEMS")
 */
const MIN_MARKET_CAP = 4000; // Market Cap minimum : $4,000 USD (seuil minimal pour considérer le token vivant)
const MIN_HOLDERS = 7; // Nombre minimum de holders : 7 (preuve qu'il y a d'autres acheteurs que le dev)
const ALPHA_ALERT_THRESHOLD = 70; // Seuil d'alerte Alpha : 70 points

/**
 * Blacklist sémantique : Mots interdits dans le nom ou le symbole du token
 * Kill Switch : Si un mot interdit est trouvé, pénalité de -100 points immédiate
 */
const BLACKLIST_WORDS = [
  'test',
  'shit',
  'cum',
  'tits',
  'dick',
  'ass',
  'sex',
  'bot',
  'gamble',
  'scam',
  'rug',
  'pussy',
  '1111',
  'bitch',
  'fucker',
  'minoor',
  'nigga',
  'nigger',
  'faggot',
] as const;

/**
 * Cache pour le prix SOL (évite les appels API répétés)
 */
let cachedSolPrice: number | null = null;
let cacheTimestamp: number = 0;
const CACHE_DURATION = 60000; // 1 minute

/**
 * Récupère le prix du SOL en USD via l'API CoinGecko
 * @returns {Promise<number>} Prix du SOL en USD
 */
export async function fetchSolPrice(): Promise<number> {
  try {
    // Vérifier le cache
    const now = Date.now();
    if (cachedSolPrice !== null && now - cacheTimestamp < CACHE_DURATION) {
      return cachedSolPrice;
    }

    // Appel API CoinGecko
    const response = await axios.get<{ solana: { usd: number } }>(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { timeout: 3000 }
    );

    const price = response.data?.solana?.usd;
    if (price && price > 0) {
      cachedSolPrice = price;
      cacheTimestamp = now;
      return price;
    }

    throw new Error('Prix SOL invalide depuis l\'API');
  } catch (error) {
    // Si erreur mais cache disponible, utiliser le cache même expiré
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
 * @returns {number} Market Cap en USD (0 si données manquantes)
 */
export function calculateMarketCap(reserves?: TokenReserves, solPriceUsd: number = 100): number {
  // Gérer proprement les cas où les données manquent
  if (!reserves) {
    return 0;
  }

  if (reserves.vSolReserves <= 0 || reserves.tokenReserves <= 0) {
    return 0;
  }

  // Formule pump.fun : (vSolReserves / vTokenReserves) * 1,000,000,000 * currentSolPrice
  const marketCap = (reserves.vSolReserves / reserves.tokenReserves) * PUMP_FUN_TOTAL_SUPPLY * solPriceUsd;

  return Math.max(0, marketCap);
}

/**
 * Vérifie si un lien Twitter est valide (fonction utilitaire exportée pour réutilisation)
 */
export function isValidTwitterLink(url: string): boolean {
  // Regex pour Twitter/X : https://twitter.com/... ou https://x.com/...
  const twitterRegex = /^https?:\/\/(www\.)?(twitter\.com|x\.com)\/[a-zA-Z0-9_]+/i;
  return twitterRegex.test(url);
}

/**
 * Vérifie si un lien Telegram est valide (fonction utilitaire exportée pour réutilisation)
 */
export function isValidTelegramLink(url: string): boolean {
  // Regex pour Telegram : https://t.me/... ou https://telegram.me/...
  const telegramRegex = /^https?:\/\/(t\.me|telegram\.me)\/[a-zA-Z0-9_]+/i;
  return telegramRegex.test(url);
}

/**
 * SCORING "MOMENTUM" : Évalue le Market Cap
 * @param {number} marketCap - Market Cap en USD
 * @returns {{ score: number; reason: string }} Score et raison
 */
function evaluateMarketCapMomentum(marketCap: number): { score: number; reason: string } {
  if (marketCap >= 15000) {
    return { score: 40, reason: `✅ MC: $${marketCap.toFixed(0)} (Forte traction)` };
  }
  
  if (marketCap >= 5000) {
    return { score: 20, reason: `✅ MC: $${marketCap.toFixed(0)} (Traction confirmée)` };
  }
  
  // Entre 4000 et 5000 : pas de points mais passe le filtre
  return { score: 0, reason: `📊 MC: $${marketCap.toFixed(0)} (Minimum requis)` };
}

/**
 * SCORING "MOMENTUM" : Évalue la Bonding Curve
 * @param {number} progress - Progression de la bonding curve (0-100)
 * @returns {{ score: number; reason: string }} Score et raison
 */
function evaluateBondingCurveMomentum(progress: number): { score: number; reason: string } {
  if (progress > 5) {
    return { score: 20, reason: `✅ Bonding curve: ${progress.toFixed(2)}% (Momentum confirmé)` };
  }
  
  return { score: 0, reason: `📊 Bonding curve: ${progress.toFixed(2)}% (Trop récent)` };
}

/**
 * SCORING "MOMENTUM" : Évalue la présence sociale
 * @param {TokenMetadata} metadata - Métadonnées du token
 * @returns {{ score: number; reasons: string[] }} Score et raisons
 */
function evaluateSocialPresenceMomentum(metadata?: TokenMetadata): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  if (!metadata?.social) {
    return { score: 0, reasons: [] };
  }

  const { twitter, telegram, website } = metadata.social;
  let hasSocialNetwork = false;

  // Au moins 1 réseau social (Twitter OU Telegram) : +20 pts
  if (twitter && isValidTwitterLink(twitter)) {
    score += 20;
    hasSocialNetwork = true;
    reasons.push(`✅ Twitter présent`);
  }

  if (telegram && isValidTelegramLink(telegram)) {
    if (!hasSocialNetwork) {
      // Si Twitter n'est pas présent, Telegram compte pour les 20 pts
      score += 20;
      hasSocialNetwork = true;
    }
    reasons.push(`✅ Telegram présent`);
  }

  // Site Web : +10 pts
  if (website) {
    try {
      const url = new URL(website);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        score += 10;
        reasons.push(`✅ Website présent`);
      }
    } catch {
      // URL invalide, ignorer
    }
  }

  if (!hasSocialNetwork) {
    reasons.push(`❌ Aucun réseau social valide (Twitter ou Telegram requis)`);
  }

  return { score, reasons };
}

/**
 * SCORING "MOMENTUM" : Évalue la distribution des holders
 * @param {HolderData[]} holders - Liste des holders
 * @param {string} devAddress - Adresse officielle du développeur (optionnelle)
 * @returns {{ score: number; penalty: number; reasons: string[] }} Score, pénalité et raisons
 */
function evaluateHoldersMomentum(
  holders: HolderData[],
  devAddress?: string
): { score: number; penalty: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  let penalty = 0;

  if (holders.length === 0) {
    return { score: 0, penalty: 0, reasons: [] };
  }

  const realHolders = holders.filter((h) => h.address !== PUMP_CURVE_ADDRESS);
  
  if (realHolders.length === 0) {
    return { score: 0, penalty: 0, reasons: [] };
  }

  // Vérifier si Top 1 Holder > 30% (pénalité -50 pts)
  const top1Holder = realHolders[0];
  if (top1Holder && top1Holder.percentage > 30) {
    // Exclure le dev officiel si son adresse est fournie
    if (!devAddress || top1Holder.address !== devAddress) {
      penalty = -50;
      reasons.push(`🚨 CRITIQUE: Top 1 wallet détient ${top1Holder.percentage.toFixed(2)}% (risque de dump massif)`);
    }
  }

  // Bonus : +20 pts si > 20 holders ET Top 10 < 30%
  if (realHolders.length > 20) {
    const top10Holders = realHolders.slice(0, 10);
    const top10Percentage = top10Holders.reduce((acc, curr) => acc + curr.percentage, 0);
    
    if (top10Percentage < 30) {
      score = 20;
      reasons.push(`✅ Excellente distribution: ${realHolders.length} holders, Top 10 détient ${top10Percentage.toFixed(2)}%`);
    } else {
      reasons.push(`📊 Distribution: ${realHolders.length} holders, Top 10 détient ${top10Percentage.toFixed(2)}%`);
    }
  } else {
    reasons.push(`📊 Distribution: ${realHolders.length} holders`);
  }

  return { score, penalty, reasons };
}

/**
 * Vérifie la blacklist sémantique
 * @param {TokenData} token - Données du token
 * @returns {{ penalty: number; reason: string | null }} Pénalité et raison
 */
function checkBlacklist(token: TokenData): { penalty: number; reason: string | null } {
  const metadata = token.metadata;
  if (!metadata) {
    return { penalty: 0, reason: null };
  }

  const nameLower = metadata.name?.toLowerCase() || '';
  const symbolLower = metadata.symbol?.toLowerCase() || '';
  
  // Chercher un mot interdit dans le nom ou le symbole
  const blacklistedWord = BLACKLIST_WORDS.find((word) => 
    nameLower.includes(word.toLowerCase()) || symbolLower.includes(word.toLowerCase())
  );
  
  if (blacklistedWord) {
    return { 
      penalty: -100, 
      reason: `⛔ BLACKLIST: Mot interdit détecté ("${blacklistedWord}")` 
    };
  }

  return { penalty: 0, reason: null };
}

/**
 * Valide un token et retourne un score de 0 à 100
 * STRATÉGIE "MOMENTUM / GEMS" : Basée sur la traction réelle
 * @param {TokenData} token - Données du token à analyser
 * @param {ValidateTokenOptions} options - Options de validation (prix SOL, etc.)
 * @returns {Promise<TokenAnalysisResult>} Résultat de l'analyse avec score et détails
 */
export async function validateToken(
  token: TokenData,
  options: ValidateTokenOptions = {}
): Promise<TokenAnalysisResult> {
  const reasons: string[] = [];
  let totalScore = 0; // Base Score : 0

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

  // Calcul du Market Cap et de la Bonding Curve Progress
  const marketCap = calculateMarketCap(token.reserves, solPriceUsd);
  const progress = calculateBondingCurveProgress(token.reserves);

  // FILTRE ÉLIMINATOIRE 1 : Market Cap minimum
  if (marketCap < MIN_MARKET_CAP) {
    return {
      score: 0,
      isAlphaAlert: false,
      marketCap,
      bondingCurveProgress: progress,
      breakdown: {
        socialScore: 0,
        bondingCurveScore: 0,
        antiRugScore: 0,
        devHoldingPenalty: 0,
        holdersScore: 0,
      },
      reasons: [`❌ MC trop faible ($${marketCap.toFixed(0)} < $${MIN_MARKET_CAP.toLocaleString()})`],
    };
  }

  // FILTRE ÉLIMINATOIRE 2 : Nombre minimum de holders
  const holders = options.holders || [];
  if (holders.length < MIN_HOLDERS) {
    return {
      score: 0,
      isAlphaAlert: false,
      marketCap,
      bondingCurveProgress: progress,
      breakdown: {
        socialScore: 0,
        bondingCurveScore: 0,
        antiRugScore: 0,
        devHoldingPenalty: 0,
        holdersScore: 0,
      },
      reasons: [`❌ Pas assez de holders (${holders.length} < ${MIN_HOLDERS})`],
    };
  }

  // SCORING "MOMENTUM" : Market Cap
  const marketCapResult = evaluateMarketCapMomentum(marketCap);
  totalScore += marketCapResult.score;
  reasons.push(marketCapResult.reason);

  // SCORING "MOMENTUM" : Bonding Curve
  const bondingCurveResult = evaluateBondingCurveMomentum(progress);
  const bondingCurveScore = bondingCurveResult.score;
  totalScore += bondingCurveScore;
  reasons.push(bondingCurveResult.reason);

  // SCORING "MOMENTUM" : Socials
  const socialResult = evaluateSocialPresenceMomentum(token.metadata);
  const socialScore = socialResult.score;
  totalScore += socialScore;
  reasons.push(...socialResult.reasons);

  // SCORING "MOMENTUM" : Holders
  const holdersResult = evaluateHoldersMomentum(holders, options.devAddress);
  const holdersScore = holdersResult.score;
  totalScore += holdersScore;
  totalScore += holdersResult.penalty; // Pénalité Top 1 > 30%
  reasons.push(...holdersResult.reasons);

  // BLACKLIST : Vérification des mots interdits
  const blacklistResult = checkBlacklist(token);
  totalScore += blacklistResult.penalty;
  if (blacklistResult.reason) {
    reasons.push(blacklistResult.reason);
  }

  // Évaluation anti-rug basique (nom + symbole + image)
  let antiRugScore = 0;
  if (token.metadata) {
    const hasName = Boolean(token.metadata.name && token.metadata.name.trim().length > 0);
    const hasSymbol = Boolean(token.metadata.symbol && token.metadata.symbol.trim().length > 0);
    const hasImage = Boolean(token.metadata.image);

    if (hasName && hasSymbol) {
      antiRugScore += 10;
      reasons.push('✅ Nom + Symbole présents');
    }

    if (hasImage) {
      antiRugScore += 10;
      reasons.push('✅ Image présente');
    }
  }
  totalScore += antiRugScore;

  // Évaluation de la détention du développeur (pénalité si > 10%)
  let devHoldingPenalty = 0;
  if (token.devHolding !== undefined && token.devHolding !== null && token.devHolding > 10) {
    devHoldingPenalty = -50;
    totalScore += devHoldingPenalty;
    reasons.push(`🚨 Pénalité: Détention développeur trop élevée (${token.devHolding}% > 10%)`);
  }

  // Analyse IA : UNIQUEMENT si le score est déjà élevé (économie de CPU)
  let aiScoreModifier = 0;
  if (totalScore > 50) {
    try {
      const aiResult = await analyzeTokenSemantics(
        token.metadata?.name,
        token.metadata?.symbol,
        token.metadata?.description
      );

      if (aiResult.sentimentScore > 80) {
        aiScoreModifier += 10;
        reasons.push(`🤖 AI: Narratif '${aiResult.narrative}' détecté (sentiment: ${aiResult.sentimentScore})`);
      } else if (aiResult.narrative && aiResult.narrative !== 'Unknown') {
        reasons.push(`🤖 AI: Narratif '${aiResult.narrative}' détecté (sentiment: ${aiResult.sentimentScore})`);
      }

      if (aiResult.isLowEffort) {
        aiScoreModifier -= 20;
        reasons.push(`🚨 AI: Contenu faible effort détecté (${aiResult.riskLabel})`);
      } else if (aiResult.riskLabel && aiResult.riskLabel !== 'Neutral') {
        reasons.push(`⚠️ AI: Risque '${aiResult.riskLabel}' détecté`);
      }
    } catch (error) {
      // En cas d'erreur, continuer sans modifier le score (ne jamais bloquer le scanner)
      console.warn('[Analyzer] Erreur lors de l\'analyse IA:', error);
    }
  }
  totalScore += aiScoreModifier;

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
