/**
 * Script de test pour l'intégration Ollama / Analyse IA
 * @module test-ai
 */

import chalk from 'chalk';
import { analyzeTokenSemantics } from './services/aiService.js';
import { validateToken } from './services/analyzer.js';
import type { TokenData } from './services/analyzer.js';

/**
 * Teste la connexion à Ollama
 */
async function testOllamaConnection(): Promise<boolean> {
  console.log(chalk.blue('\n🔍 Test de connexion à Ollama...'));

  try {
    const axios = (await import('axios')).default;
    const response = await axios.get('http://localhost:11434/api/tags', {
      timeout: 2000,
    });

    const models = response.data.models || [];
    const hasQwen = models.some((m: { name: string }) => m.name === 'qwen2.5:0.5b');

    if (hasQwen) {
      console.log(chalk.green('✅ Ollama est accessible et le modèle qwen2.5:0.5b est disponible'));
      return true;
    } else {
      console.log(chalk.yellow('⚠️  Ollama est accessible mais le modèle qwen2.5:0.5b n\'est pas trouvé'));
      console.log(chalk.yellow('   Exécutez: ollama pull qwen2.5:0.5b'));
      return false;
    }
  } catch (error) {
    console.log(chalk.red('❌ Ollama n\'est pas accessible'));
    console.log(chalk.red('   Assurez-vous qu\'Ollama est démarré: ollama serve'));
    return false;
  }
}

/**
 * Teste l'analyse sémantique avec différents cas
 */
async function testSemanticAnalysis(): Promise<void> {
  console.log(chalk.blue('\n🧠 Test de l\'analyse sémantique...\n'));

  const testCases = [
    {
      name: 'PepeCoin',
      symbol: 'PEPE',
      description: 'The most memeable memecoin in existence. The dogs have had their day, it\'s time for Pepe to take reign.',
      expectedNarrative: 'Pepe',
    },
    {
      name: 'Generic Token',
      symbol: 'GEN',
      description: 'This is a revolutionary cryptocurrency that will change the world. Join our community and be part of the future of finance.',
      expectedLowEffort: true,
    },
    {
      name: 'TrumpCoin',
      symbol: 'TRUMP',
      description: 'MAGA token supporting the 47th President. Make America Great Again!',
      expectedNarrative: 'PolitiFi',
    },
    {
      name: 'CatCoin',
      symbol: 'CAT',
      description: 'Meow meow meow. The cutest cat token on Solana. Purr your way to the moon!',
      expectedNarrative: 'Cat',
    },
  ];

  for (const testCase of testCases) {
    console.log(chalk.cyan(`\n📊 Test: ${testCase.name} (${testCase.symbol})`));
    console.log(chalk.gray(`   Description: ${testCase.description.substring(0, 60)}...`));

    const startTime = Date.now();
    const result = await analyzeTokenSemantics(testCase.name, testCase.symbol, testCase.description);
    const duration = Date.now() - startTime;

    console.log(chalk.white(`   ⏱️  Temps de réponse: ${duration}ms`));
    console.log(chalk.white(`   📝 Narratif: ${chalk.bold(result.narrative)}`));
    console.log(chalk.white(`   💯 Score de sentiment: ${chalk.bold(result.sentimentScore)}/100`));
    console.log(chalk.white(`   ⚠️  Faible effort: ${chalk.bold(result.isLowEffort ? 'Oui' : 'Non')}`));
    console.log(chalk.white(`   🏷️  Label de risque: ${chalk.bold(result.riskLabel)}`));

    // Vérifications
    if (testCase.expectedNarrative && result.narrative.toLowerCase().includes(testCase.expectedNarrative.toLowerCase())) {
      console.log(chalk.green(`   ✅ Narratif attendu détecté: ${testCase.expectedNarrative}`));
    }

    if (testCase.expectedLowEffort !== undefined && result.isLowEffort === testCase.expectedLowEffort) {
      console.log(chalk.green(`   ✅ Détection faible effort: ${testCase.expectedLowEffort ? 'Oui' : 'Non'}`));
    }

    if (duration > 3000) {
      console.log(chalk.yellow(`   ⚠️  Attention: Temps de réponse > 3000ms (timeout configuré)`));
    } else {
      console.log(chalk.green(`   ✅ Temps de réponse acceptable (< 3000ms)`));
    }
  }
}

/**
 * Teste l'intégration complète avec l'analyzer
 */
async function testAnalyzerIntegration(): Promise<void> {
  console.log(chalk.blue('\n🔗 Test de l\'intégration avec l\'analyzer...\n'));

  // Token avec un bon score préliminaire (devrait déclencher l'IA)
  const highScoreToken: TokenData = {
    address: 'TestAddress123',
    freeMint: false,
    devHolding: 5,
    metadata: {
      name: 'PepeMoon',
      symbol: 'PEPEM',
      description: 'The ultimate Pepe memecoin. Join the revolution and moon together!',
      image: 'https://example.com/image.png',
      social: {
        twitter: 'https://twitter.com/pepemoon',
        telegram: 'https://t.me/pepemoon',
      },
    },
    reserves: {
      vSolReserves: 45, // Zone Alpha (15-60%)
      tokenReserves: 500_000_000,
    },
  };

  console.log(chalk.cyan('📊 Analyse d\'un token avec score préliminaire élevé...'));
  console.log(chalk.gray(`   Nom: ${highScoreToken.metadata?.name}`));
  console.log(chalk.gray(`   Bonding Curve: ~${((45 - 30) / 55) * 100}% (Zone Alpha)`));

  const startTime = Date.now();
  const result = await validateToken(highScoreToken);
  const duration = Date.now() - startTime;

  console.log(chalk.white(`\n⏱️  Temps total d'analyse: ${duration}ms`));
  console.log(chalk.white(`💯 Score final: ${chalk.bold(result.score)}/100`));
  console.log(chalk.white(`🚨 Alerte Alpha: ${chalk.bold(result.isAlphaAlert ? 'Oui' : 'Non')}`));

  // Vérifier si l'IA a été appelée (présence de "AI:" dans les reasons)
  const aiReasons = result.reasons.filter((r) => r.includes('🤖 AI:'));
  if (aiReasons.length > 0) {
    console.log(chalk.green('\n✅ L\'analyse IA a été intégrée:'));
    aiReasons.forEach((reason) => {
      console.log(chalk.green(`   ${reason}`));
    });
  } else {
    console.log(chalk.yellow('\n⚠️  L\'analyse IA n\'a pas été déclenchée'));
    console.log(chalk.yellow('   (Score préliminaire peut-être < 50 ou token hors zone Alpha)'));
  }

  console.log(chalk.cyan('\n📋 Toutes les raisons:'));
  result.reasons.forEach((reason) => {
    console.log(chalk.gray(`   ${reason}`));
  });
}

/**
 * Fonction principale
 */
async function main(): Promise<void> {
  console.log(chalk.bold.blue('\n╔══════════════════════════════════════════════════════════╗'));
  console.log(chalk.bold.blue('║     Test d\'intégration Ollama / Analyse IA              ║'));
  console.log(chalk.bold.blue('╚══════════════════════════════════════════════════════════╝'));

  // Test 1: Connexion Ollama
  const isConnected = await testOllamaConnection();
  if (!isConnected) {
    console.log(chalk.red('\n❌ Les tests ne peuvent pas continuer sans Ollama'));
    process.exit(1);
  }

  // Test 2: Analyse sémantique
  await testSemanticAnalysis();

  // Test 3: Intégration avec l'analyzer
  await testAnalyzerIntegration();

  console.log(chalk.bold.green('\n✅ Tous les tests sont terminés!\n'));
}

// Exécution
main().catch((error) => {
  console.error(chalk.red('\n❌ Erreur lors des tests:'), error);
  process.exit(1);
});

