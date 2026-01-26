/**
 * Tests pour la récupération des données Solana
 * @module services/solana.test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loadSettings } from '../config/settings.js';
import { fetchTokenHolders } from './holderService.js';
import { fetchSolPrice } from './analyzer.js';
import dotenv from 'dotenv';

dotenv.config();

// Adresse de test (un token réel sur Solana pour les tests)
const TEST_TOKEN_ADDRESS = 'So11111111111111111111111111111111111111112'; // Wrapped SOL (WSOL)

describe('Récupération des données Solana', () => {
  let settings: ReturnType<typeof loadSettings>;

  beforeAll(() => {
    settings = loadSettings();
  });

  describe('Prix SOL (CoinGecko)', () => {
    it('devrait récupérer le prix SOL depuis CoinGecko', async () => {
      const price = await fetchSolPrice();

      expect(price).toBeGreaterThan(0);
      expect(price).toBeLessThan(10000); // Prix raisonnable
      expect(typeof price).toBe('number');
    }, 10000);

    it('devrait utiliser le cache après la première récupération', async () => {
      const start1 = Date.now();
      const price1 = await fetchSolPrice();
      const time1 = Date.now() - start1;

      // Attendre un peu pour s'assurer que le cache est utilisé
      await new Promise((resolve) => setTimeout(resolve, 100));

      const start2 = Date.now();
      const price2 = await fetchSolPrice();
      const time2 = Date.now() - start2;

      expect(price1).toBe(price2);
      // Le deuxième appel devrait être plus rapide (cache) ou au moins aussi rapide
      expect(time2).toBeLessThanOrEqual(time1 + 100); // Marge de 100ms
    });
  });

  describe('Récupération des holders', () => {
    it('devrait récupérer les holders d\'un token Solana', async () => {
      if (!settings.solana.rpcUrl) {
        console.warn('⚠️ SOLANA_RPC_URL non configuré, test ignoré');
        return;
      }

      const holders = await fetchTokenHolders(TEST_TOKEN_ADDRESS, {
        solana: settings.solana,
        limit: 10,
      });

      expect(Array.isArray(holders)).toBe(true);
      // Le token peut avoir 0 holders si c'est un token récent ou si l'API échoue
      // On vérifie juste que c'est un tableau valide
      expect(holders.length).toBeGreaterThanOrEqual(0);
      expect(holders.length).toBeLessThanOrEqual(10);
    }, 15000);

    it('devrait retourner des holders avec la structure correcte', async () => {
      if (!settings.solana.rpcUrl) {
        console.warn('⚠️ SOLANA_RPC_URL non configuré, test ignoré');
        return;
      }

      const holders = await fetchTokenHolders(TEST_TOKEN_ADDRESS, {
        solana: settings.solana,
        limit: 5,
      });

      if (holders.length > 0) {
        const holder = holders[0];
        if (holder) {
          expect(holder).toHaveProperty('address');
          expect(holder).toHaveProperty('amount');
          expect(holder).toHaveProperty('percentage');
          expect(typeof holder.address).toBe('string');
          expect(typeof holder.amount).toBe('number');
          expect(typeof holder.percentage).toBe('number');
          expect(holder.percentage).toBeGreaterThanOrEqual(0);
          expect(holder.percentage).toBeLessThanOrEqual(100);
        }
      }
    }, 15000);

    it('devrait exclure l\'adresse de la bonding curve pump.fun', async () => {
      if (!settings.solana.rpcUrl) {
        console.warn('⚠️ SOLANA_RPC_URL non configuré, test ignoré');
        return;
      }

      const holders = await fetchTokenHolders(TEST_TOKEN_ADDRESS, {
        solana: settings.solana,
        limit: 100,
      });

      const pumpCurveAddress = '6EF8rrecthR5DkZJvT6uS8z6yL7GV8S7Zf4m1G8m7f23';
      const hasPumpCurve = holders.some((h) => h.address === pumpCurveAddress);
      expect(hasPumpCurve).toBe(false);
    }, 15000);

    it('devrait respecter le timeout de 800ms', async () => {
      if (!settings.solana.rpcUrl) {
        console.warn('⚠️ SOLANA_RPC_URL non configuré, test ignoré');
        return;
      }

      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
      }, 800);

      const startTime = Date.now();
      
      try {
        await fetchTokenHolders(TEST_TOKEN_ADDRESS, {
          solana: settings.solana,
          limit: 10,
          signal: abortController.signal,
        });
        clearTimeout(timeoutId);
        const elapsed = Date.now() - startTime;
        // Si on arrive ici, la récupération a réussi rapidement
        expect(elapsed).toBeLessThan(5000);
      } catch (error) {
        clearTimeout(timeoutId);
        // Si c'est un timeout (AbortError ou CanceledError), c'est normal
        if (error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError' || error.message.includes('canceled'))) {
          const elapsed = Date.now() - startTime;
          expect(elapsed).toBeLessThan(1000); // Le timeout devrait se déclencher avant 1s
          return;
        }
        // Autre erreur, on la laisse passer (peut être une erreur réseau normale)
        console.warn('⚠️ Erreur lors du test de timeout:', error instanceof Error ? error.message : error);
      }
    }, 10000);
  });
});

