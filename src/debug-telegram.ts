/**
 * Script de diagnostic pour vérifier la configuration Telegram
 * @module debug-telegram
 */

import dotenv from 'dotenv';
import chalk from 'chalk';
import axios from 'axios';

dotenv.config();

async function debugTelegram(): Promise<void> {
  console.log(chalk.bold.blue('\n╔══════════════════════════════════════╗'));
  console.log(chalk.bold.blue('║   DIAGNOSTIC TELEGRAM                ║'));
  console.log(chalk.bold.blue('╚══════════════════════════════════════╝\n'));

  // Vérifier les variables d'environnement
  const botToken = process.env['TELEGRAM_BOT_TOKEN'];
  const chatId = process.env['TELEGRAM_CHAT_ID'];

  console.log(chalk.blue('📋 Variables d\'environnement:'));
  console.log(`   TELEGRAM_BOT_TOKEN: ${botToken ? chalk.green('✅ Présent') : chalk.red('❌ Manquant')}`);
  if (botToken) {
    const tokenPreview = botToken.length > 20 
      ? `${botToken.substring(0, 10)}...${botToken.substring(botToken.length - 5)}`
      : '***';
    console.log(chalk.gray(`      (${tokenPreview})`));
  }
  
  console.log(`   TELEGRAM_CHAT_ID: ${chatId ? chalk.green('✅ Présent') : chalk.red('❌ Manquant')}`);
  if (chatId) {
    console.log(chalk.gray(`      Valeur: "${chatId}"`));
    console.log(chalk.gray(`      Type: ${typeof chatId}`));
    console.log(chalk.gray(`      Longueur: ${chatId.length} caractères`));
  }
  console.log('');

  if (!botToken) {
    console.error(chalk.red('❌ TELEGRAM_BOT_TOKEN manquant dans .env'));
    process.exit(1);
  }

  if (!chatId) {
    console.error(chalk.red('❌ TELEGRAM_CHAT_ID manquant dans .env'));
    process.exit(1);
  }

  // Tester le bot
  console.log(chalk.blue('🤖 Test du bot...'));
  try {
    const botResponse = await axios.get(
      `https://api.telegram.org/bot${botToken}/getMe`
    );

    if (botResponse.data.ok) {
      const bot = botResponse.data.result;
      console.log(chalk.green('✅ Bot valide:'));
      console.log(`   Nom: ${bot.first_name}`);
      console.log(`   Username: @${bot.username}`);
      console.log(`   ID: ${bot.id}\n`);
    } else {
      console.error(chalk.red('❌ Bot invalide'));
      process.exit(1);
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const errorMsg = error.response?.data?.description || error.message;
      console.error(chalk.red(`❌ Erreur bot: ${errorMsg}`));
      if (errorMsg.includes('Unauthorized')) {
        console.log(chalk.yellow('\n💡 Le token du bot est invalide. Vérifiez TELEGRAM_BOT_TOKEN dans .env\n'));
      }
    } else {
      console.error(chalk.red('❌ Erreur inconnue:'), error);
    }
    process.exit(1);
  }

  // Tester l'envoi d'un message simple
  console.log(chalk.blue(`📤 Test d'envoi vers Chat ID: ${chatId}...`));
  try {
    // Essayer avec le chat ID comme nombre (parfois nécessaire)
    const chatIdNum = parseInt(chatId, 10);
    console.log(chalk.gray(`   Tentative avec Chat ID (nombre): ${chatIdNum}`));
    
    let response = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: chatIdNum, // Essayer comme nombre
        text: '🧪 Test de notification depuis Gem Scanner',
        parse_mode: 'HTML', // Utiliser HTML au lieu de MarkdownV2 pour simplifier
      }
    );

    if (response.data.ok) {
      console.log(chalk.green.bold('\n✅ MESSAGE ENVOYÉ AVEC SUCCÈS !'));
      console.log(chalk.gray(`   Message ID: ${response.data.result.message_id}\n`));
      console.log(chalk.blue('💡 Vérifiez votre Telegram pour voir le message de test.\n'));
      return;
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const errorData = error.response?.data;
      const errorMsg = errorData?.description || error.message;
      
      console.error(chalk.red(`❌ Erreur d'envoi: ${errorMsg}`));
      
      if (errorMsg.includes('chat not found')) {
        console.log(chalk.yellow('\n💡 Solutions possibles:'));
        console.log('   1. Vérifiez que le Chat ID est correct (sans guillemets, sans espaces)');
        console.log('   2. Pour un chat privé, envoyez d\'abord /start au bot');
        console.log('   3. Pour un groupe, ajoutez le bot au groupe et envoyez un message');
        console.log('   4. Le Chat ID peut être négatif pour les groupes (ex: -1001234567890)');
        console.log(chalk.blue('\n   Pour obtenir votre Chat ID:'));
        console.log('   → Exécutez: npm run get-chat-id');
        console.log('   → Ou utilisez @userinfobot sur Telegram\n');
      } else if (errorMsg.includes('bot was blocked')) {
        console.log(chalk.yellow('\n💡 Le bot a été bloqué. Débloquez-le dans Telegram.\n'));
      } else if (errorMsg.includes('chat_id is empty')) {
        console.log(chalk.yellow('\n💡 Le Chat ID est vide. Vérifiez votre fichier .env\n'));
      } else {
        console.log(chalk.yellow(`\n💡 Détails de l'erreur:`));
        console.log(chalk.gray(JSON.stringify(errorData, null, 2)));
      }
    } else {
      console.error(chalk.red('❌ Erreur inconnue:'), error);
    }
    process.exit(1);
  }
}

debugTelegram().catch((error) => {
  console.error(chalk.red('Erreur fatale:'), error);
  process.exit(1);
});

