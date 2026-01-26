/**
 * Tests d'intégration du flux complet
 * @module integration.test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loadSettings, validateSettings } from './config/settings.js';
import { validateToken, fetchSolPrice, type TokenData } from './services/analyzer.js';
import { fetchTokenHolders, type HolderData } from './services/holderService.js';
import { createNotifier } from './services/notifier.js';
import dotenv from 'dotenv';

dotenv.config();

describe('Tests d\'intégration - Flux complet', () => {
  let settings: ReturnType<typeof loadSettings>;

  beforeAll(() => {
    settings = loadSettings();
    validateSettings(settings);
  });

  it('devrait charger et valider la configuration', () => {
    expect(settings).toBeTruthy();
    expect(settings.solana.rpcUrl).toBeTruthy();
    expect(settings.telegram.botToken).toBeTruthy();
    expect(settings.telegram.chatId).toBeTruthy();
  });

  it('devrait créer un token de test complet et l\'analyser', async () => {
    const testToken: TokenData = {
      address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      freeMint: false,
      devHolding: 5,
      metadata: {
        name: 'Integration Test Token',
        symbol: 'INTEG',
        description: 'Token pour test d\'intégration',
        image: 'https://example.com/image.png',
        social: {
          twitter: 'https://twitter.com/integtoken',
          telegram: 'https://t.me/integtoken',
        },
      },
      reserves: {
        vSolReserves: 40,
        tokenReserves: 460,
      },
    };

    // Récupérer le prix SOL
    const solPrice = await fetchSolPrice();
    expect(solPrice).toBeGreaterThan(0);

    // Analyser le token
    const analysis = await validateToken(testToken, {
      solPriceUsd: solPrice,
    });

    expect(analysis).toBeTruthy();
    expect(analysis.score).toBeGreaterThanOrEqual(0);
    expect(analysis.score).toBeLessThanOrEqual(100);
    expect(analysis.marketCap).toBeGreaterThan(0);
    expect(analysis.bondingCurveProgress).toBeGreaterThanOrEqual(0);
    expect(analysis.bondingCurveProgress).toBeLessThanOrEqual(100);
  });

  it('devrait analyser un token avec holders (Shadow Scan)', async () => {
    if (!settings.solana.rpcUrl) {
      console.warn('⚠️ SOLANA_RPC_URL non configuré, test ignoré');
      return;
    }

    const testToken: TokenData = {
      address: 'So11111111111111111111111111111111111111112', // WSOL pour test
      freeMint: false,
      metadata: {
        name: 'Test with Holders',
        symbol: 'TEST',
      },
      reserves: {
        vSolReserves: 50,
        tokenReserves: 450,
      },
    };

    // Récupérer les holders
    const holders = await fetchTokenHolders(testToken.address, {
      solana: settings.solana,
      limit: 10,
    }).catch(() => [] as HolderData[]);

    // Analyser avec holders
    const solPrice = await fetchSolPrice();
    const analysis = await validateToken(testToken, {
      solPriceUsd: solPrice,
      holders: holders.length > 0 ? holders : undefined,
    });

    expect(analysis).toBeTruthy();
    expect(analysis.breakdown.holdersScore).toBeDefined();
    expect(typeof analysis.breakdown.holdersScore).toBe('number');
  });

  it('devrait créer et tester le notifier Telegram', async () => {
    const notifier = createNotifier({ telegram: settings.telegram });

    // Tester la connexion
    const isConnected = await notifier.testConnection();
    expect(isConnected).toBe(true);
  });

  it('devrait normaliser les réserves correctement', () => {
    // Test de normalisation automatique
    const normalizeValue = (value: unknown): number => {
      if (typeof value === 'number') {
        return value > 1_000_000_000 ? value / 1e9 : value;
      }
      if (typeof value === 'string') {
        const parsed = parseFloat(value);
        return parsed > 1_000_000_000 ? parsed / 1e9 : parsed;
      }
      return 0;
    };

    // Test avec valeur en lamports (> 1e9)
    expect(normalizeValue(50_000_000_000)).toBe(50);
    
    // Test avec valeur normale (< 1e9)
    expect(normalizeValue(50)).toBe(50);
    
    // Test avec string
    expect(normalizeValue('50000000000')).toBe(50);
    expect(normalizeValue('50')).toBe(50);
  });

  it('devrait valider une adresse Solana', () => {
    const isValidSolanaAddress = (address: string): boolean => {
      if (!address || typeof address !== 'string') {
        return false;
      }
      if (address.length < 32 || address.length > 44) {
        return false;
      }
      const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
      return base58Regex.test(address);
    };

    // Adresses valides
    expect(isValidSolanaAddress('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')).toBe(true);
    expect(isValidSolanaAddress('So11111111111111111111111111111111111111112')).toBe(true);

    // Adresses invalides
    expect(isValidSolanaAddress('invalid')).toBe(false);
    expect(isValidSolanaAddress('')).toBe(false);
    expect(isValidSolanaAddress('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU0')).toBe(false); // Contient 0
  });
});

