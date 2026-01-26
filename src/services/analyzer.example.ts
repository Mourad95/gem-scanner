/**
 * Exemple d'utilisation du service analyzer
 * @module services/analyzer.example
 */

import { validateToken, calculateMarketCap, fetchSolPrice, type TokenData } from './analyzer.js';

// Exemple 1 : Token avec toutes les caractéristiques positives
const alphaToken: TokenData = {
  address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  freeMint: false,
  metadata: {
    name: 'Alpha Token',
    symbol: 'ALPHA',
    description: 'Un token prometteur avec une équipe solide',
    image: 'https://example.com/image.png',
    social: {
      twitter: 'https://twitter.com/alphatoken',
      telegram: 'https://t.me/alphatoken',
      website: 'https://alphatoken.com',
    },
  },
  reserves: {
    vSolReserves: 50, // 50 SOL virtuels
    tokenReserves: 450, // 450 tokens
    // Bonding curve = 50 / (50 + 450) = 10% (dans la cible 5-20%)
  },
};

// Exemple 2 : Token avec des caractéristiques moyennes
const averageToken: TokenData = {
  address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  freeMint: false,
  metadata: {
    name: 'Average Token',
    symbol: 'AVG',
    description: 'Un token standard',
    social: {
      twitter: 'https://twitter.com/averagetoken',
      // Pas de Telegram
    },
  },
  reserves: {
    vSolReserves: 10,
    tokenReserves: 90,
    // Bonding curve = 10% (dans la cible)
  },
};

// Exemple 3 : Token suspect (rug potentiel)
const suspiciousToken: TokenData = {
  address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  freeMint: true, // Red flag
  metadata: {
    name: 'Suspicious',
    // Métadonnées incomplètes
  },
  reserves: {
    vSolReserves: 1,
    tokenReserves: 99,
    // Bonding curve = 1% (hors cible)
  },
};

// Analyse des tokens (async maintenant)
(async () => {
  try {
    console.log('=== Analyse Alpha Token ===');
    const alphaResult = await validateToken(alphaToken);
    console.log(`Score: ${alphaResult.score}/100`);
    console.log(`Alerte Alpha: ${alphaResult.isAlphaAlert}`);
    console.log(`Bonding Curve: ${alphaResult.bondingCurveProgress.toFixed(2)}%`);
    console.log(`Market Cap: $${alphaResult.marketCap.toLocaleString()}`);
    console.log('Détails:', alphaResult.reasons);
    console.log('Breakdown:', alphaResult.breakdown);

    console.log('\n=== Analyse Average Token ===');
    const averageResult = await validateToken(averageToken);
    console.log(`Score: ${averageResult.score}/100`);
    console.log(`Alerte Alpha: ${averageResult.isAlphaAlert}`);
    console.log(`Bonding Curve: ${averageResult.bondingCurveProgress.toFixed(2)}%`);
    console.log(`Market Cap: $${averageResult.marketCap.toLocaleString()}`);
    console.log('Détails:', averageResult.reasons);

    console.log('\n=== Analyse Suspicious Token ===');
    const suspiciousResult = await validateToken(suspiciousToken);
    console.log(`Score: ${suspiciousResult.score}/100`);
    console.log(`Alerte Alpha: ${suspiciousResult.isAlphaAlert}`);
    console.log(`Bonding Curve: ${suspiciousResult.bondingCurveProgress.toFixed(2)}%`);
    console.log(`Market Cap: $${suspiciousResult.marketCap.toLocaleString()}`);
    console.log('Détails:', suspiciousResult.reasons);

    // Calcul direct du Market Cap (nécessite le prix SOL)
    console.log('\n=== Calcul Market Cap ===');
    const solPrice = await fetchSolPrice();
    const marketCap = calculateMarketCap(alphaToken.reserves, solPrice);
    console.log(`Prix SOL: $${solPrice}`);
    console.log(`Market Cap calculé: $${marketCap.toLocaleString()}`);
  } catch (error) {
    console.error('Erreur:', error);
  }
})();

