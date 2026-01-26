/**
 * Script utilitaire pour obtenir le Chat ID Telegram
 * @module get-chat-id
 * 
 * Instructions:
 * 1. Créez un groupe Telegram ou utilisez votre chat privé
 * 2. Ajoutez votre bot au groupe ou démarrez une conversation avec lui
 * 3. Envoyez un message au bot (n'importe quel message)
 * 4. Exécutez ce script pour obtenir le Chat ID
 */

import dotenv from 'dotenv';
import axios from 'axios';
import chalk from 'chalk';

dotenv.config();

async function getChatId(): Promise<void> {
  const botToken = process.env['TELEGRAM_BOT_TOKEN'];

  if (!botToken) {
    console.error(chalk.red('❌ TELEGRAM_BOT_TOKEN non trouvé dans .env'));
    process.exit(1);
  }

  try {
    console.log(chalk.blue('📡 Récupération des mises à jour du bot...\n'));

    const response = await axios.get(
      `https://api.telegram.org/bot${botToken}/getUpdates`,
      {
        params: {
          offset: -10, // Récupérer les 10 derniers messages
        },
      }
    );

    const updates = response.data?.result || [];

    if (updates.length === 0) {
      console.log(chalk.yellow('⚠️ Aucune mise à jour trouvée.'));
      console.log(chalk.blue('\n💡 Pour obtenir votre Chat ID:'));
      console.log('   1. Envoyez un message à votre bot (n\'importe quel message)');
      console.log('   2. Ou ajoutez le bot à un groupe et envoyez un message');
      console.log('   3. Relancez ce script\n');
      return;
    }

    console.log(chalk.green(`✅ ${updates.length} mise(s) à jour trouvée(s)\n`));
    console.log(chalk.bold('📋 Chat IDs disponibles:\n'));

    const chatIds = new Set<string>();

    updates.forEach((update: { message?: { chat: { id: number; type: string; title?: string; username?: string } } }) => {
      if (update.message?.chat) {
        const chat = update.message.chat;
        const chatId = String(chat.id);
        
        if (!chatIds.has(chatId)) {
          chatIds.add(chatId);
          
          const chatType = chat.type === 'private' ? '👤 Privé' : 
                          chat.type === 'group' ? '👥 Groupe' : 
                          chat.type === 'supergroup' ? '👥 Supergroupe' : 
                          chat.type === 'channel' ? '📢 Canal' : chat.type;
          
          const chatName = chat.title || chat.username || 'Sans nom';
          
          console.log(chalk.cyan(`   ${chatType}: ${chatName}`));
          console.log(chalk.bold(`   Chat ID: ${chalk.green(chatId)}\n`));
        }
      }
    });

    if (chatIds.size > 0) {
      console.log(chalk.blue('\n💡 Ajoutez ce Chat ID dans votre fichier .env:'));
      console.log(chalk.bold(`   TELEGRAM_CHAT_ID=${Array.from(chatIds)[0]}\n`));
    }

  } catch (error) {
    if (axios.isAxiosError(error)) {
      const errorMessage = error.response?.data?.description || error.message;
      console.error(chalk.red(`❌ Erreur: ${errorMessage}`));
      
      if (errorMessage.includes('Unauthorized')) {
        console.log(chalk.yellow('\n💡 Vérifiez que votre TELEGRAM_BOT_TOKEN est correct\n'));
      }
    } else {
      console.error(chalk.red('❌ Erreur inconnue:'), error);
    }
    process.exit(1);
  }
}

getChatId().catch((error) => {
  console.error(chalk.red('Erreur fatale:'), error);
  process.exit(1);
});

