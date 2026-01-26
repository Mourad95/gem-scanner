/**
 * Script de test end-to-end avec pumpportal.fun et Solana RPC
 * @module test-pumpportal
 */

import WebSocket from 'ws';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { loadSettings, validateSettings } from './config/settings.js';
import { validateToken, fetchSolPrice, type TokenData } from './services/analyzer.js';
import { fetchTokenHolders, type HolderData } from './services/holderService.js';
import { createNotifier } from './services/notifier.js';

dotenv.config();

/**
 * Parse un message pumpportal.fun
 */
function parsePumpPortalMessage(message: unknown): TokenData | null {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const msg = message as Record<string, unknown>;

  if (msg['type'] !== 'subscribeNewToken' && msg['event'] !== 'subscribeNewToken') {
    return null;
  }

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

/**
 * Normalise les réserves
 */
function normalizeReserves(reserves: TokenData['reserves']): TokenData['reserves'] {
  if (!reserves) return undefined;

  const normalizeValue = (value: number): number => {
    return value > 1_000_000_000 ? value / 1e9 : value;
  };

  return {
    vSolReserves: normalizeValue(reserves.vSolReserves),
    tokenReserves: normalizeValue(reserves.tokenReserves),
  };
}

/**
 * Valide une adresse Solana
 */
function isValidSolanaAddress(address: string): boolean {
  if (!address || typeof address !== 'string') return false;
  if (address.length < 32 || address.length > 44) return false;
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
  return base58Regex.test(address);
}

/**
 * Test principal
 */
async function testPumpPortal(): Promise<void> {
  try {
    console.log(chalk.bold.blue('\n╔══════════════════════════════════════╗'));
    console.log(chalk.bold.blue('║   TEST PUMPPORTAL.FUN + SOLANA RPC   ║'));
    console.log(chalk.bold.blue('╚══════════════════════════════════════╝\n'));

    // Charger la configuration
    console.log(chalk.blue('📋 Chargement de la configuration...'));
    const settings = loadSettings();
    validateSettings(settings);
    console.log(chalk.green('✅ Configuration chargée'));
    console.log(chalk.gray(`   RPC URL: ${settings.solana.rpcUrl}`));
    console.log(chalk.gray(`   RPC Key: ${settings.solana.rpcKey ? '✅ Présent' : '❌ Absent'}\n`));

    // Précharger le prix SOL
    console.log(chalk.blue('💰 Récupération du prix SOL...'));
    const solPrice = await fetchSolPrice();
    console.log(chalk.green(`✅ Prix SOL: $${solPrice.toFixed(2)}\n`));

    // Créer le notifier
    const notifier = createNotifier({ telegram: settings.telegram });

    // Connexion WebSocket
    const wsUrl = process.env['WEBSOCKET_URL'] || 'wss://pumpportal.fun/api/data';
    console.log(chalk.blue(`🔌 Connexion au WebSocket: ${wsUrl}...`));

    let tokensProcessed = 0;
    let alertsSent = 0;
    let errorsCount = 0;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        console.log(chalk.green('✅ WebSocket connecté à pumpportal.fun'));
        console.log(chalk.blue('👂 En attente de nouveaux tokens...\n'));
      });

      ws.on('message', async (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          const tokenData = parsePumpPortalMessage(message);

          if (!tokenData || !tokenData.address) {
            return; // Message non-pertinent
          }

          // Valider l'adresse
          if (!isValidSolanaAddress(tokenData.address)) {
            console.warn(chalk.yellow(`⚠️ Adresse invalide ignorée: ${tokenData.address}`));
            return;
          }

          tokensProcessed++;
          console.log(chalk.cyan(`\n📦 Token #${tokensProcessed} reçu:`));
          console.log(chalk.gray(`   Adresse: ${tokenData.address}`));
          console.log(chalk.gray(`   Nom: ${tokenData.metadata?.name || 'N/A'}`));
          console.log(chalk.gray(`   Symbol: ${tokenData.metadata?.symbol || 'N/A'}`));

          // Normaliser les réserves
          if (tokenData.reserves) {
            tokenData.reserves = normalizeReserves(tokenData.reserves);
            if (tokenData.reserves) {
              console.log(chalk.gray(`   vSolReserves: ${tokenData.reserves.vSolReserves}`));
              console.log(chalk.gray(`   tokenReserves: ${tokenData.reserves.tokenReserves}`));
            }
          }

          // Récupérer les holders avec Solana RPC
          console.log(chalk.blue('   🔍 Récupération des holders via Solana RPC...'));
          const startHolders = Date.now();

          const abortController = new AbortController();
          const timeoutId = setTimeout(() => abortController.abort(), 800);

          const holders = await fetchTokenHolders(tokenData.address, {
            solana: settings.solana,
            limit: 10,
            signal: abortController.signal,
          })
            .then((result) => {
              clearTimeout(timeoutId);
              return result;
            })
            .catch((error: unknown) => {
              clearTimeout(timeoutId);
              if (error instanceof Error && error.name === 'AbortError') {
                console.warn(chalk.yellow(`   ⏱️ Timeout holders (800ms)`));
              } else {
                console.warn(chalk.yellow(`   ⚠️ Erreur holders: ${error instanceof Error ? error.message : 'Inconnue'}`));
              }
              return [] as HolderData[];
            });

          const holdersTime = Date.now() - startHolders;
          console.log(chalk.gray(`   ✅ Holders récupérés: ${holders.length} (${holdersTime}ms)`));

          if (holders.length > 0) {
            const top10 = holders.slice(0, 10);
            const top10Percentage = top10.reduce((sum, h) => sum + h.percentage, 0);
            console.log(chalk.gray(`   📊 Top 10 détient: ${top10Percentage.toFixed(2)}%`));
          }

          // Analyser le token
          console.log(chalk.blue('   📊 Analyse du token...'));
          const startAnalysis = Date.now();

          const analysis = await validateToken(tokenData, {
            solPriceUsd: solPrice,
            holders: holders.length > 0 ? holders : undefined,
          });

          const analysisTime = Date.now() - startAnalysis;
          console.log(chalk.cyan(`   ✅ Score: ${analysis.score}/100 (${analysisTime}ms)`));
          console.log(chalk.gray(`      - Social: ${analysis.breakdown.socialScore}pts`));
          console.log(chalk.gray(`      - Bonding Curve: ${analysis.breakdown.bondingCurveScore}pts`));
          console.log(chalk.gray(`      - Anti-Rug: ${analysis.breakdown.antiRugScore}pts`));
          console.log(chalk.gray(`      - Holders: ${analysis.breakdown.holdersScore}pts`));

          // Détecter les scams
          const isScamDetected =
            analysis.score < 30 &&
            analysis.breakdown.holdersScore < 0 &&
            (analysis.breakdown.holdersScore <= -40 ||
              analysis.reasons.some((r) => r.includes('CRITIQUE') || r.includes('dump massif')));

          if (isScamDetected) {
            console.log(chalk.red.bold(`\n   🚨 [SCAM DETECTED] Score: ${analysis.score}/100`));
          }

          // Si alerte alpha, envoyer notification
          if (analysis.isAlphaAlert) {
            console.log(chalk.green.bold(`\n   🚨 ALERTE ALPHA DÉTECTÉE !`));
            try {
              await notifier.sendAlert(tokenData, analysis);
              alertsSent++;
              console.log(chalk.green('   ✅ Notification Telegram envoyée\n'));
            } catch (error) {
              errorsCount++;
              console.error(chalk.red(`   ❌ Erreur envoi: ${error instanceof Error ? error.message : error}\n`));
            }
          } else {
            console.log(chalk.gray('   ⚪ Pas d\'alerte (score insuffisant)\n'));
          }

          // Limiter à 5 tokens pour le test
          if (tokensProcessed >= 5) {
            console.log(chalk.yellow('\n⚠️ Limite de 5 tokens atteinte, arrêt du test\n'));
            ws.close();
            resolve();
          }
        } catch (error) {
          errorsCount++;
          if (error instanceof SyntaxError) {
            // Message non-JSON, ignorer
            return;
          }
          console.error(chalk.red(`❌ Erreur traitement: ${error instanceof Error ? error.message : error}`));
        }
      });

      ws.on('error', (error) => {
        console.error(chalk.red('❌ Erreur WebSocket:'), error);
        reject(error);
      });

      ws.on('close', () => {
        console.log(chalk.yellow('\n⚠️ WebSocket fermé'));
        console.log(chalk.blue('\n📊 Résumé du test:'));
        console.log(`   Tokens traités: ${chalk.cyan(tokensProcessed)}`);
        console.log(`   Alertes envoyées: ${chalk.green(alertsSent)}`);
        console.log(`   Erreurs: ${chalk.red(errorsCount)}\n`);
        resolve();
      });

      // Timeout de sécurité après 2 minutes
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          console.log(chalk.yellow('\n⏱️ Timeout de 2 minutes atteint, fermeture...'));
          ws.close();
          resolve();
        }
      }, 120000);
    });
  } catch (error) {
    console.error(chalk.red('❌ Erreur fatale:'), error);
    process.exit(1);
  }
}

// Lancer le test
testPumpPortal().catch((error) => {
  console.error(chalk.red('Erreur non gérée:'), error);
  process.exit(1);
});

