/**
 * Script de test pour vérifier l'envoi de notifications Telegram
 * @module test-telegram
 */

import dotenv from 'dotenv';
import chalk from 'chalk';
import { loadSettings, validateSettings } from './config/settings.js';
import { validateToken, type TokenData } from './services/analyzer.js';
import { createNotifier } from './services/notifier.js';
import type { HolderData } from './services/holderService.js';

// Charger les variables d'environnement
dotenv.config();

/**
 * Crée un token de test avec toutes les caractéristiques positives (score > 70)
 */
function createTestToken(): TokenData {
  return {
    address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', // Adresse Solana valide de test
    freeMint: false,
    devHolding: 5, // Détention développeur acceptable (< 10%)
    metadata: {
      name: 'Test Alpha Token',
      symbol: 'TEST',
      description: 'Token de test pour vérifier les notifications Telegram avec toutes les caractéristiques optimales',
      image: 'https://example.com/image.png',
      social: {
        twitter: 'https://twitter.com/testtoken', // Lien valide
        telegram: 'https://t.me/testtoken', // Lien valide
        website: 'https://testtoken.com',
      },
    },
    reserves: {
      vSolReserves: 40, // 40 SOL (dans la zone alpha 15-60% : 40/(40+460) = 8% → progress = (40-30)/(85-30) = 18.18%)
      tokenReserves: 460,
    },
  };
}

/**
 * Crée des holders de test avec excellente distribution (Top 10 < 15%)
 */
function createTestHolders(): HolderData[] {
  return [
    { address: 'Address1', amount: 30_000_000, percentage: 3.0 },
    { address: 'Address2', amount: 25_000_000, percentage: 2.5 },
    { address: 'Address3', amount: 20_000_000, percentage: 2.0 },
    { address: 'Address4', amount: 15_000_000, percentage: 1.5 },
    { address: 'Address5', amount: 12_000_000, percentage: 1.2 },
    { address: 'Address6', amount: 10_000_000, percentage: 1.0 },
    { address: 'Address7', amount: 8_000_000, percentage: 0.8 },
    { address: 'Address8', amount: 6_000_000, percentage: 0.6 },
    { address: 'Address9', amount: 5_000_000, percentage: 0.5 },
    { address: 'Address10', amount: 3_000_000, percentage: 0.3 },
    // Total Top 10: ~13.4% (excellente distribution = +40 points)
  ];
}

/**
 * Fonction principale de test
 */
async function testTelegramNotification(): Promise<void> {
  try {
    console.log(chalk.bold.blue('\n╔══════════════════════════════════════╗'));
    console.log(chalk.bold.blue('║   TEST NOTIFICATION TELEGRAM         ║'));
    console.log(chalk.bold.blue('╚══════════════════════════════════════╝\n'));

    // Charger et valider la configuration
    console.log(chalk.blue('📋 Chargement de la configuration...'));
    const settings = loadSettings();
    validateSettings(settings);
    console.log(chalk.green('✅ Configuration validée\n'));

    // Créer le notifier
    console.log(chalk.blue('🔧 Création du service de notification...'));
    const notifier = createNotifier({ telegram: settings.telegram });
    
    // Tester la connexion
    console.log(chalk.blue('🔌 Test de connexion Telegram...'));
    await notifier.testConnection();
    console.log(chalk.green('✅ Connexion Telegram OK'));
    console.log(chalk.gray(`   Chat ID configuré: ${settings.telegram.chatId}\n`));

    // Créer un token de test
    console.log(chalk.blue('🎯 Création d\'un token de test...'));
    const testToken = createTestToken();
    console.log(chalk.green(`✅ Token de test créé: ${testToken.metadata?.name} (${testToken.metadata?.symbol})\n`));

    // Analyser le token
    console.log(chalk.blue('📊 Analyse du token...'));
    const testHolders = createTestHolders();
    const analysis = await validateToken(testToken, {
      solPriceUsd: 122.47, // Prix SOL actuel
      holders: testHolders,
    });

    console.log(chalk.cyan(`\n📈 Résultats de l'analyse:`));
    console.log(`   Score: ${chalk.bold(analysis.score)}/100`);
    console.log(`   Alerte Alpha: ${analysis.isAlphaAlert ? chalk.green('OUI') : chalk.red('NON')}`);
    console.log(`   Market Cap: $${analysis.marketCap.toLocaleString()}`);
    console.log(`   Bonding Curve: ${analysis.bondingCurveProgress.toFixed(2)}%`);
    console.log(`\n   Breakdown:`);
    console.log(`   - Social: ${analysis.breakdown.socialScore}pts`);
    console.log(`   - Bonding Curve: ${analysis.breakdown.bondingCurveScore}pts`);
    console.log(`   - Anti-Rug: ${analysis.breakdown.antiRugScore}pts`);
    console.log(`   - Holders: ${analysis.breakdown.holdersScore}pts`);

    // Si le score est suffisant, envoyer la notification
    if (analysis.isAlphaAlert) {
      console.log(chalk.blue('\n📤 Envoi de la notification Telegram...'));
      try {
        await notifier.sendAlert(testToken, analysis);
        console.log(chalk.green.bold('\n✅ NOTIFICATION ENVOYÉE AVEC SUCCÈS !'));
        console.log(chalk.gray('   Vérifiez votre chat Telegram pour voir le message.\n'));
      } catch (error) {
        console.error(chalk.red('\n❌ Erreur lors de l\'envoi:'), error);
        throw error;
      }
    } else {
      console.log(chalk.yellow('\n⚠️ Le token de test n\'a pas un score suffisant pour déclencher une alerte.'));
      console.log(chalk.yellow(`   Score requis: > 70, Score actuel: ${analysis.score}`));
      console.log(chalk.blue('\n💡 Pour forcer l\'envoi, vous pouvez modifier le seuil dans analyzer.ts\n'));
    }

  } catch (error) {
    console.error(chalk.red('\n❌ Erreur lors du test:'), error);
    if (error instanceof Error) {
      console.error(chalk.red(`   Message: ${error.message}`));
    }
    process.exit(1);
  }
}

// Lancer le test
testTelegramNotification().catch((error) => {
  console.error(chalk.red('Erreur fatale:'), error);
  process.exit(1);
});

