/**
 * Service d'analyse et de validation de tokens Solana
 * MODE "SNIPER ÉLITE" : Filtrage strict pour éviter les faux positifs
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
  isAlphaAlert: boolean; // True si score > 55
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
const ALPHA_ALERT_THRESHOLD = 60; // Mode "Sniper Élite" : Seuil très strict pour filtrer le bruit

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
 * Seuils pour l'analyse des holders
 */
const HOLDERS_TOP10_MAX = 30; // Si Top 10 > 30%, pénalité lourde
const HOLDERS_TOP10_GOOD = 15; // Si Top 10 < 15%, bonne distribution
const HOLDERS_SINGLE_WALLET_MAX = 30; // Si un seul wallet > 30%, pénalité critique
const HOLDERS_TOP10_PENALTY = 40; // Pénalité si Top 10 > 30%
const HOLDERS_SINGLE_WALLET_PENALTY = 50; // Pénalité si un wallet > 30%

/**
 * Points attribués pour chaque critère
 * Mode "Sniper Élite" : Scoring strict
 */
const SCORING = {
  SOCIAL_TWITTER: 20, // Twitter présent et valide
  SOCIAL_TELEGRAM: 15, // Telegram présent et valide
  SOCIAL_WEBSITE: 10, // Website présent et valide
  SOCIAL_BONUS_ALL: 10, // Bonus Trifecta (Twitter + Telegram + Website)
  BONDING_CURVE_ALPHA: 12, // Zone alpha (15-60%)
  BONDING_CURVE_GOOD: 6, // Zone acceptable (5-15% ou 60-80%)
  ANTI_RUG_BASIC: 10, // Nom + Symbole présents
  ANTI_RUG_IMAGE: 10, // Image présente
  FRESH_MINT_BONUS: 20, // Bonus pour mint très récent (< 2% bonding curve)
  HOLDERS_EXCELLENT: 40, // Excellente distribution (Top 10 < 15%)
  HOLDERS_GOOD: 20, // Bonne distribution (Top 10 < 30%)
  HOLDERS_NEUTRAL: 10, // Score neutre si holders vides (Block 0)
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
 * Vérifie la présence sociale du token avec validation des liens
 * MODE "SNIPER ÉLITE" : Twitter seul insuffisant pour déclencher une alerte
 * @param {TokenMetadata} metadata - Métadonnées du token
 * @returns {{ score: number, reasons: string[] }} Score de présence sociale et raisons
 */
function evaluateSocialPresence(metadata?: TokenMetadata): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  if (!metadata?.social) {
    return { score: 0, reasons: [] };
  }

  const { twitter, telegram, website } = metadata.social;
  let hasTwitter = false;
  let hasTelegram = false;
  let hasWebsite = false;

  // Twitter : +20 pts si présent et valide
  if (twitter) {
    const twitterValid = isValidTwitterLink(twitter);
    if (twitterValid) {
      score += SCORING.SOCIAL_TWITTER;
      hasTwitter = true;
      reasons.push(`✅ Twitter présent`);
    }
  }

  // Telegram : +15 pts si présent et valide
  if (telegram) {
    const telegramValid = isValidTelegramLink(telegram);
    if (telegramValid) {
      score += SCORING.SOCIAL_TELEGRAM;
      hasTelegram = true;
      reasons.push(`✅ Telegram présent`);
    }
  }

  // Website : +10 pts si présent et valide
  if (website) {
    // Vérifier que c'est une URL valide
    try {
      const url = new URL(website);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        score += SCORING.SOCIAL_WEBSITE;
        hasWebsite = true;
        reasons.push(`✅ Website présent`);
      }
    } catch {
      // URL invalide, ignorer
    }
  }

  // Bonus Trifecta : +10 pts si les trois sont présents
  if (hasTwitter && hasTelegram && hasWebsite) {
    score += SCORING.SOCIAL_BONUS_ALL;
    reasons.push(`🎯 Bonus Trifecta (Twitter + Telegram + Website)`);
  }

  return { score, reasons };
}

/**
 * Évalue la bonding curve du token
 * @param {TokenReserves} reserves - Réserves du token
 * @returns {number} Score de bonding curve (0 à 12)
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
 * MODE "SNIPER ÉLITE" : Vérifie la blacklist sémantique (name ET symbol)
 * Kill Switch : Pénalité de -100 points si mot interdit trouvé
 * @param {TokenData} token - Données du token
 * @returns {{ score: number; blacklistPenalty: number; blacklistReason: string | null }} Score anti-rug et pénalité blacklist
 */
function evaluateAntiRug(token: TokenData): {
  score: number;
  blacklistPenalty: number;
  blacklistReason: string | null;
} {
  let score = 0;
  let blacklistPenalty = 0;
  let blacklistReason: string | null = null;

  // Vérification de la blacklist sémantique (insensible à la casse)
  // Vérifier dans le NOM ET le SYMBOLE
  const metadata = token.metadata;
  if (metadata) {
    const nameLower = metadata.name?.toLowerCase() || '';
    const symbolLower = metadata.symbol?.toLowerCase() || '';
    
    // Chercher un mot interdit dans le nom
    const blacklistedWordInName = BLACKLIST_WORDS.find((word) => nameLower.includes(word.toLowerCase()));
    
    // Chercher un mot interdit dans le symbole
    const blacklistedWordInSymbol = BLACKLIST_WORDS.find((word) => symbolLower.includes(word.toLowerCase()));
    
    const blacklistedWord = blacklistedWordInName || blacklistedWordInSymbol;
    
    if (blacklistedWord) {
      blacklistPenalty = -100; // Kill Switch : Pénalité massive de -100 points
      blacklistReason = `⛔ BLACKLIST: Mot interdit détecté ("${blacklistedWord}")`;
    }
  }

  // Vérification freeMint : si false ou non défini (considéré comme sécurisé)
  if (token.freeMint === false || token.freeMint === undefined) {
    // Pas de points pour freeMint dans cette version simplifiée
  }

  // Vérification de la cohérence des métadonnées
  if (metadata) {
    const hasName = Boolean(metadata.name && metadata.name.trim().length > 0);
    const hasSymbol = Boolean(metadata.symbol && metadata.symbol.trim().length > 0);
    const hasImage = Boolean(metadata.image);

    // ANTI_RUG_BASIC : Nom + Symbole = +10 pts
    if (hasName && hasSymbol) {
      score += SCORING.ANTI_RUG_BASIC;
    }

    // ANTI_RUG_IMAGE : Image présente = +10 pts
    if (hasImage) {
      score += SCORING.ANTI_RUG_IMAGE;
    }
  }

  return { score, blacklistPenalty, blacklistReason };
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
 * MODE "SNIPER ÉLITE" : Si holders vides (Block 0), score neutre (0 ou +10), pas de bonus excessif
 * @param {HolderData[]} holders - Liste des holders
 * @param {string} devAddress - Adresse officielle du développeur (optionnelle)
 * @returns {number} Score de distribution (-50 à +40)
 */
function evaluateHolders(holders: HolderData[], devAddress?: string): number {
  if (!holders || holders.length === 0) {
    // Cas fréquent au Block 0 : score neutre, pas de bonus excessif
    return SCORING.HOLDERS_NEUTRAL; // +10 pts neutre
  }

  // Filtrer l'adresse de la bonding curve pump.fun
  const realHolders = holders.filter((h) => h.address !== PUMP_CURVE_ADDRESS);

  if (realHolders.length === 0) {
    // Même si la liste n'est pas vide mais qu'après filtrage il n'y a rien, score neutre
    return SCORING.HOLDERS_NEUTRAL; // +10 pts neutre
  }

  // Calculer le pourcentage total détenu par le Top 10
  const top10Holders = realHolders.slice(0, 10);
  const top10Percentage = top10Holders.reduce((acc, curr) => acc + curr.percentage, 0);

  // Vérifier si un seul wallet (hors dev) possède > 30%
  const singleWalletRisk = realHolders.find((holder) => {
    // Exclure le dev officiel si son adresse est fournie
    if (devAddress && holder.address === devAddress) {
      return false;
    }
    return holder.percentage > HOLDERS_SINGLE_WALLET_MAX;
  });

  // Pénalité critique : un seul wallet > 30%
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
 * MODE "SNIPER ÉLITE" : Filtrage strict pour éviter les faux positifs
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
  const socialResult = evaluateSocialPresence(token.metadata);
  const socialScore = socialResult.score;
  totalScore += socialScore;
  reasons.push(...socialResult.reasons);
  
  if (socialScore === 0) {
    const social = token.metadata?.social;
    if (social?.twitter || social?.telegram || social?.website) {
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

  // Évaluation anti-rug (avec blacklist)
  const antiRugResult = evaluateAntiRug(token);
  const antiRugScore = antiRugResult.score;
  totalScore += antiRugScore;
  
  // Appliquer la pénalité blacklist (Kill Switch : -100 points)
  if (antiRugResult.blacklistPenalty < 0) {
    totalScore += antiRugResult.blacklistPenalty;
    if (antiRugResult.blacklistReason) {
      reasons.push(antiRugResult.blacklistReason);
    }
  }
  
  const maxAntiRugScore = SCORING.ANTI_RUG_BASIC + SCORING.ANTI_RUG_IMAGE; // 20 points max
  if (antiRugScore >= maxAntiRugScore) {
    reasons.push('✅ Mesures anti-rug complètes (Nom + Symbole + Image)');
  } else if (antiRugScore >= SCORING.ANTI_RUG_BASIC) {
    reasons.push('⚠️ Mesures anti-rug partielles (Nom + Symbole)');
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

  // Évaluation de la distribution des holders (Shadow Scan)
  let holdersScore = 0;
  let holders: HolderData[] | undefined = options.holders;

  if (!holders) {
    // Les holders devront être récupérés par l'appelant via holderService
    reasons.push('⚠️ Analyse des holders non disponible (Shadow Scan ignoré)');
  } else {
    holdersScore = evaluateHolders(holders, options.devAddress);

    // Calculer le Top 10 pour les messages (si holders non vide)
    if (holders.length > 0) {
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
    } else if (holdersScore === SCORING.HOLDERS_NEUTRAL) {
      reasons.push(
        `📊 Distribution neutre (pas de holders au Block 0 - normal)`
      );
    }
  }

  totalScore += holdersScore;

  // Fresh Mint Bonus : Si bonding curve < 2% ET métadonnées existent, +20 pts
  // Note : Ce bonus ne sert à rien si la règle "No Social" s'active (voir ci-dessous)
  let freshMintBonus = 0;
  if (progress < 2 && token.metadata && (token.metadata.name || token.metadata.symbol)) {
    freshMintBonus = SCORING.FRESH_MINT_BONUS;
    totalScore += freshMintBonus;
    reasons.push(`🚀 Bonus Fresh Mint (bonding curve < 2% avec métadonnées)`);
  }

  // Calcul du score préliminaire (avant analyse IA)
  const preliminaryScore = totalScore;
  const isInAlphaZone = progress >= BONDING_CURVE_ALPHA_MIN && progress <= BONDING_CURVE_ALPHA_MAX;

  // Analyse IA : UNIQUEMENT si preliminaryScore > 50 OU si le token est en zone Alpha
  // Ne gaspille pas de CPU sur les tokens faibles
  let aiScoreModifier = 0;
  if (preliminaryScore > 50 || isInAlphaZone) {
    try {
      const aiResult = await analyzeTokenSemantics(
        token.metadata?.name,
        token.metadata?.symbol,
        token.metadata?.description
      );

      // Intégration des résultats de l'IA au score final
      if (aiResult.sentimentScore > 80) {
        aiScoreModifier += 10; // Narratif fort détecté
        reasons.push(`🤖 AI: Narratif '${aiResult.narrative}' détecté (sentiment: ${aiResult.sentimentScore})`);
      } else if (aiResult.narrative && aiResult.narrative !== 'Unknown') {
        reasons.push(`🤖 AI: Narratif '${aiResult.narrative}' détecté (sentiment: ${aiResult.sentimentScore})`);
      }

      if (aiResult.isLowEffort) {
        aiScoreModifier -= 20; // Arnaque probable (description générique ChatGPT)
        reasons.push(`🚨 AI: Contenu faible effort détecté (${aiResult.riskLabel})`);
      } else if (aiResult.riskLabel && aiResult.riskLabel !== 'Neutral') {
        reasons.push(`⚠️ AI: Risque '${aiResult.riskLabel}' détecté`);
      }
    } catch (error) {
      // En cas d'erreur, continuer sans modifier le score (ne jamais bloquer le scanner)
      console.warn('[Analyzer] Erreur lors de l\'analyse IA:', error);
    }
  }

  // Appliquer la modification du score IA
  totalScore += aiScoreModifier;

  // RÈGLE "NO SOCIAL, NO PARTY" (Plafond de verre) - MODE "SNIPER ÉLITE"
  // C'est la règle la plus importante : À la toute fin du calcul
  // Si score social = 0 (aucun lien Twitter/TG/Web valide), forcer le score à maximum 30
  // Cela empêchera mécaniquement tout token sans projet de déclencher une alerte
  if (socialScore === 0) {
    const maxScoreWithoutSocial = 30;
    if (totalScore > maxScoreWithoutSocial) {
      totalScore = maxScoreWithoutSocial;
      reasons.push(`⛔ Rejeté: Aucun social (Sniper Mode)`);
    }
  }

  // RÈGLE ADDITIONNELLE "TWITTER SEUL INSUFFISANT" - MODE "SNIPER ÉLITE"
  // Si seulement Twitter (20pts) sans Telegram ni Website, plafonner à 50 maximum
  // Pour déclencher une alerte, il faut au moins Twitter + Telegram OU Twitter + Website
  const social = token.metadata?.social;
  const hasTwitter = social?.twitter && isValidTwitterLink(social.twitter);
  const hasTelegram = social?.telegram && isValidTelegramLink(social.telegram);
  const hasWebsite = social?.website && (() => {
    try {
      const url = new URL(social.website);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  })();

  // Si seulement Twitter (sans Telegram ni Website), plafonner à 50
  if (hasTwitter && !hasTelegram && !hasWebsite && socialScore === SCORING.SOCIAL_TWITTER) {
    const maxScoreTwitterOnly = 50;
    if (totalScore > maxScoreTwitterOnly) {
      totalScore = maxScoreTwitterOnly;
      reasons.push(`⛔ Rejeté: Twitter seul insuffisant (Sniper Mode - Telegram ou Website requis)`);
    }
  }

  // Calcul du Market Cap (gère proprement les cas où les données manquent)
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
