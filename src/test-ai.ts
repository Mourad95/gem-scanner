/**
 * Script de test pour l'intégration Ollama / Analyse IA
 * @module test-ai
 */

import chalk from 'chalk';
import { analyzeTokenSentiment } from './services/aiService.js';
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
 * Teste l'analyse de sentiment avec différents cas
 */
async function testSemanticAnalysis(): Promise<void> {
  console.log(chalk.blue('\n🧠 Test de l\'analyse de sentiment...\n'));

  const testCases = [
    {
      name: 'PepeCoin',
      symbol: 'PEPE',
      expectedHighScore: true, // Devrait avoir un score élevé (meme viral)
    },
    {
      name: 'Generic Token',
      symbol: 'GEN',
      expectedHighScore: false, // Devrait avoir un score faible (générique)
    },
    {
      name: 'TrumpCoin',
      symbol: 'TRUMP',
      expectedHighScore: true, // Devrait avoir un score élevé (trend politique)
    },
    {
      name: 'CatCoin',
      symbol: 'CAT',
      expectedHighScore: true, // Devrait avoir un score élevé (animal meme)
    },
  ];

  for (const testCase of testCases) {
    console.log(chalk.cyan(`\n📊 Test: ${testCase.name} (${testCase.symbol})`));

    const startTime = Date.now();
    const sentimentScore = await analyzeTokenSentiment(testCase.name, testCase.symbol);
    const duration = Date.now() - startTime;

    console.log(chalk.white(`   ⏱️  Temps de réponse: ${duration}ms`));
    console.log(chalk.white(`   💯 Score de sentiment: ${chalk.bold(sentimentScore)}/100`));

    // Vérifications
    if (testCase.expectedHighScore && sentimentScore >= 70) {
      console.log(chalk.green(`   ✅ Score élevé attendu: ${sentimentScore}/100`));
    } else if (!testCase.expectedHighScore && sentimentScore < 50) {
      console.log(chalk.green(`   ✅ Score faible attendu: ${sentimentScore}/100`));
    } else {
      console.log(chalk.yellow(`   ⚠️  Score inattendu: ${sentimentScore}/100`));
    }

    if (duration > 5000) {
      console.log(chalk.yellow(`   ⚠️  Attention: Temps de réponse > 5000ms (timeout configuré)`));
    } else {
      console.log(chalk.green(`   ✅ Temps de réponse acceptable (< 5000ms)`));
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

  // Vérifier si l'IA a été appelée (présence de "AI" ou "IA" dans les reasons)
  const aiReasons = result.reasons.filter((r) => r.includes('🧠') || r.includes('IA') || r.includes('AI'));
  if (aiReasons.length > 0) {
    console.log(chalk.green('\n✅ L\'analyse IA a été intégrée:'));
    aiReasons.forEach((reason) => {
      console.log(chalk.green(`   ${reason}`));
    });
  } else {
    console.log(chalk.yellow('\n⚠️  L\'analyse IA n\'a pas été déclenchée'));
    console.log(chalk.yellow('   (Peut-être timeout ou erreur)'));
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

