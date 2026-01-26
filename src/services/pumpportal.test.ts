/**
 * Tests pour le parsing des messages pumpportal.fun
 * @module services/pumpportal.test
 */

import { describe, it, expect } from 'vitest';
import type { TokenData } from './analyzer.js';

/**
 * Simule le parser de messages pumpportal.fun depuis index.ts
 */
function parsePumpPortalMessage(message: unknown): TokenData | null {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const msg = message as Record<string, unknown>;

  // Vérifier que c'est un message de type 'subscribeNewToken'
  if (msg['type'] !== 'subscribeNewToken' && msg['event'] !== 'subscribeNewToken') {
    return null;
  }

  // Extraire les données du token depuis le format pumpportal.fun
  const data = (msg['data'] || msg) as Record<string, unknown>;
  const metadata = (data['metadata'] as Record<string, unknown>) || {};
  const social = (data['social'] as Record<string, unknown>) || {};
  const reserves = (data['reserves'] as Record<string, unknown>) || {};

  const tokenData: TokenData = {
    address: (data['mint'] || data['address'] || data['token'] || '') as string,
    freeMint: data['freeMint'] as boolean | undefined,
    devHolding: data['devHolding'] as number | undefined,
    metadata: {
      name: (data['name'] || metadata['name']) as string | undefined,
      symbol: (data['symbol'] || metadata['symbol']) as string | undefined,
      description: (data['description'] || metadata['description']) as string | undefined,
      image: (data['image'] || metadata['image'] || data['imageUrl']) as string | undefined,
      social: {
        twitter: (data['twitter'] || social['twitter'] || data['twitterUrl']) as string | undefined,
        telegram: (data['telegram'] || social['telegram'] || data['telegramUrl']) as string | undefined,
        website: (data['website'] || social['website'] || data['websiteUrl']) as string | undefined,
      },
    },
    reserves: {
      vSolReserves: (data['vSolReserves'] || reserves['vSolReserves'] || data['virtualSolReserves'] || 0) as number,
      tokenReserves: (data['tokenReserves'] || reserves['tokenReserves'] || data['virtualTokenReserves'] || 0) as number,
    },
  };

  return tokenData;
}

describe('Parsing messages pumpportal.fun', () => {
  it('devrait parser un message de type subscribeNewToken avec structure data', () => {
    const message = {
      type: 'subscribeNewToken',
      data: {
        mint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        name: 'Test Token',
        symbol: 'TEST',
        description: 'Un token de test',
        image: 'https://example.com/image.png',
        twitter: 'https://twitter.com/testtoken',
        telegram: 'https://t.me/testtoken',
        vSolReserves: 50,
        tokenReserves: 450,
        freeMint: false,
        devHolding: 5,
      },
    };

    const tokenData = parsePumpPortalMessage(message);

    expect(tokenData).toBeTruthy();
    expect(tokenData?.address).toBe('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
    expect(tokenData?.metadata?.name).toBe('Test Token');
    expect(tokenData?.metadata?.symbol).toBe('TEST');
    expect(tokenData?.reserves?.vSolReserves).toBe(50);
    expect(tokenData?.reserves?.tokenReserves).toBe(450);
  });

  it('devrait parser un message avec event au lieu de type', () => {
    const message = {
      event: 'subscribeNewToken',
      mint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      name: 'Test Token 2',
      symbol: 'TEST2',
      virtualSolReserves: 50000000000, // Format lamports
      virtualTokenReserves: 450000000000,
    };

    const tokenData = parsePumpPortalMessage(message);

    expect(tokenData).toBeTruthy();
    expect(tokenData?.address).toBe('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
    expect(tokenData?.metadata?.name).toBe('Test Token 2');
    expect(tokenData?.reserves?.vSolReserves).toBe(50000000000);
  });

  it('devrait retourner null pour un message non-subscribeNewToken', () => {
    const message = {
      type: 'heartbeat',
      timestamp: Date.now(),
    };

    const tokenData = parsePumpPortalMessage(message);
    expect(tokenData).toBeNull();
  });

  it('devrait gérer les métadonnées imbriquées', () => {
    const message = {
      type: 'subscribeNewToken',
      data: {
        mint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        metadata: {
          name: 'Token avec metadata',
          symbol: 'META',
          description: 'Description dans metadata',
        },
        social: {
          twitter: 'https://twitter.com/metatoken',
          telegram: 'https://t.me/metatoken',
        },
        reserves: {
          vSolReserves: 40,
          tokenReserves: 460,
        },
      },
    };

    const tokenData = parsePumpPortalMessage(message);

    expect(tokenData).toBeTruthy();
    expect(tokenData?.metadata?.name).toBe('Token avec metadata');
    expect(tokenData?.metadata?.social?.twitter).toBe('https://twitter.com/metatoken');
    expect(tokenData?.reserves?.vSolReserves).toBe(40);
  });

  it('devrait gérer les valeurs manquantes', () => {
    const message = {
      type: 'subscribeNewToken',
      data: {
        mint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        // Pas de name, symbol, etc.
      },
    };

    const tokenData = parsePumpPortalMessage(message);

    expect(tokenData).toBeTruthy();
    expect(tokenData?.address).toBe('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
    expect(tokenData?.metadata?.name).toBeUndefined();
    expect(tokenData?.reserves?.vSolReserves).toBe(0); // Valeur par défaut
  });
});

