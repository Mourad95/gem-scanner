/**
 * Service de notification Telegram pour les alertes de tokens
 * @module services/notifier
 */

import axios, { type AxiosInstance } from 'axios';
import type { TokenData, TokenAnalysisResult } from './analyzer.js';
import type { TelegramConfig } from '../config/settings.js';

/**
 * Configuration du service de notification
 */
interface NotifierConfig {
  telegram: TelegramConfig;
}

/**
 * Réponse de l'API Telegram
 */
interface TelegramApiResponse {
  ok: boolean;
  result?: {
    message_id: number;
    [key: string]: unknown;
  };
  description?: string;
}

/**
 * Bouton inline pour le clavier Telegram
 */
interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

/**
 * Clavier inline Telegram
 */
interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/**
 * Service de notification Telegram
 */
export class TelegramNotifier {
  private readonly apiClient: AxiosInstance;
  private readonly chatId: string;
  private readonly baseUrl: string;

  /**
   * Constructeur du service de notification
   * @param {NotifierConfig} config - Configuration du service
   */
  constructor(config: NotifierConfig) {
    if (!config.telegram.botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN est requis');
    }
    if (!config.telegram.chatId) {
      throw new Error('TELEGRAM_CHAT_ID est requis');
    }

    this.chatId = config.telegram.chatId;
    this.baseUrl = `https://api.telegram.org/bot${config.telegram.botToken}`;

    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Échappe les caractères spéciaux pour MarkdownV2 de Telegram
   * @param {string} text - Texte à échapper
   * @returns {string} Texte échappé
   */
  private escapeMarkdown(text: string): string {
    const specialChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
    let escaped = text;
    for (const char of specialChars) {
      escaped = escaped.replace(new RegExp(`\\${char}`, 'g'), `\\${char}`);
    }
    return escaped;
  }

  /**
   * Extrait les raisons négatives (risques) de l'analyse
   * @param {TokenAnalysisResult} analysis - Résultat de l'analyse
   * @returns {string[]} Liste des risques identifiés (sans emojis, ils seront ajoutés lors du formatage)
   */
  private extractRisks(analysis: TokenAnalysisResult): string[] {
    const riskIndicators = ['🚨', '⚠️', '❌'];
    return analysis.reasons
      .filter((reason) => riskIndicators.some((indicator) => reason.includes(indicator)))
      .map((reason) => {
        // Retirer les emojis pour les réajouter lors du formatage
        return reason.replace(/[🚨⚠️❌]/g, '').trim();
      });
  }

  /**
   * Formate le message Markdown pour l'alerte de token
   * @param {TokenData} token - Données du token
   * @param {TokenAnalysisResult} analysis - Résultat de l'analyse
   * @returns {string} Message formaté en MarkdownV2
   */
  private formatMessage(token: TokenData, analysis: TokenAnalysisResult): string {
    const name = this.escapeMarkdown(token.metadata?.name ?? 'N/A');
    const symbol = this.escapeMarkdown(token.metadata?.symbol ?? 'N/A');
    const address = token.address;
    const score = analysis.score;
    const marketCap = analysis.marketCap;
    const bondingCurveProgress = analysis.bondingCurveProgress;

    // Emoji de score selon les seuils
    let scoreEmoji: string;
    let scoreLabel: string;
    if (score > 80) {
      scoreEmoji = '🟢';
      scoreLabel = 'EXCELLENT';
    } else if (score >= 60) {
      scoreEmoji = '🟡';
      scoreLabel = 'BON';
    } else {
      scoreEmoji = '🔴';
      scoreLabel = 'MOYEN';
    }

    let message = `🚨 *ALERTE ALPHA DÉTECTÉE* 🚨\n\n`;
    
    // Informations du token
    message += `*${name}* \\(${symbol}\\)\n`;
    message += `\`${address}\`\n\n`;

    // Score avec emoji
    message += `${scoreEmoji} *Score Alpha:* ${score}/100 \\(${scoreLabel}\\)\n\n`;

    // Market Cap
    const marketCapFormatted = marketCap.toLocaleString('fr-FR', { maximumFractionDigits: 0 });
    message += `💰 *Market Cap:* $${this.escapeMarkdown(marketCapFormatted)}\n\n`;

    // Bonding Curve avec barre de progression
    const bondingCurveFormatted = bondingCurveProgress.toFixed(2);
    message += `📈 *Bonding Curve:* ${this.escapeMarkdown(bondingCurveFormatted)}%\n`;
    const bar = this.formatBondingCurveBar(bondingCurveProgress);
    message += `└─ ${this.escapeMarkdown(bar)}\n\n`;

    // Section RISQUES si des risques sont identifiés
    const risks = this.extractRisks(analysis);
    if (risks.length > 0) {
      message += `⚠️ *RISQUES*\n`;
      risks.forEach((risk) => {
        // Déterminer l'emoji selon le type de risque
        let emoji = '⚠️';
        if (risk.toLowerCase().includes('critique') || risk.toLowerCase().includes('dump massif')) {
          emoji = '🚨';
        } else if (risk.toLowerCase().includes('insuffisant') || risk.toLowerCase().includes('absente')) {
          emoji = '❌';
        }
        
        const escapedRisk = this.escapeMarkdown(risk);
        message += `${emoji} ${escapedRisk}\n`;
      });
      message += `\n`;
    }

    // Breakdown du score (optionnel, peut être commenté si trop long)
    message += `📊 *Breakdown:*\n`;
    message += `• Social: ${this.escapeMarkdown(String(analysis.breakdown.socialScore))}pts\n`;
    message += `• Bonding Curve: ${this.escapeMarkdown(String(analysis.breakdown.bondingCurveScore))}pts\n`;
    message += `• Anti\\-Rug: ${this.escapeMarkdown(String(analysis.breakdown.antiRugScore))}pts\n`;
    message += `• Holders: ${this.escapeMarkdown(String(analysis.breakdown.holdersScore))}pts\n`;
    if (analysis.breakdown.devHoldingPenalty < 0) {
      message += `• Dev Holding: ${this.escapeMarkdown(String(analysis.breakdown.devHoldingPenalty))}pts\n`;
    }

    return message;
  }

  /**
   * Formate une barre de progression pour la bonding curve
   * @param {number} percentage - Pourcentage (0-100)
   * @returns {string} Barre de progression
   */
  private formatBondingCurveBar(percentage: number): string {
    const barLength = 20;
    const filled = Math.round((percentage / 100) * barLength);
    const empty = barLength - filled;

    const filledBar = '█'.repeat(filled);
    const emptyBar = '░'.repeat(empty);

    return `[${filledBar}${emptyBar}] ${percentage.toFixed(1)}%`;
  }

  /**
   * Crée le clavier inline avec les boutons de liens
   * @param {string} tokenAddress - Adresse du token (mint address)
   * @returns {InlineKeyboardMarkup} Clavier inline
   */
  private createInlineKeyboard(tokenAddress: string): InlineKeyboardMarkup {
    return {
      inline_keyboard: [
        // Bouton proéminent Pump.fun (pleine largeur)
        [
          {
            text: '🚀 ACHETER SUR PUMP.FUN',
            url: `https://pump.fun/${tokenAddress}`,
          },
        ],
        // Première ligne : DexScreener et RugCheck
        [
          {
            text: '📊 DexScreener',
            url: `https://dexscreener.com/solana/${tokenAddress}`,
          },
          {
            text: '🛡️ RugCheck',
            url: `https://rugcheck.xyz/tokens/${tokenAddress}`,
          },
        ],
        // Deuxième ligne : Bubblemaps et GMGN
        [
          {
            text: '🫧 Bubblemaps',
            url: `https://bubblemaps.io/solana/token/${tokenAddress}`,
          },
          {
            text: '🔍 GMGN',
            url: `https://gmgn.ai/sol/token/${tokenAddress}`,
          },
        ],
      ],
    };
  }

  /**
   * Envoie une notification Telegram pour un token qui passe le filtre
   * @param {TokenData} token - Données du token
   * @param {TokenAnalysisResult} analysis - Résultat de l'analyse
   * @returns {Promise<boolean>} True si l'envoi a réussi
   * @throws {Error} Si l'envoi échoue
   */
  async sendAlert(token: TokenData, analysis: TokenAnalysisResult): Promise<boolean> {
    try {
      // Vérifier que c'est bien une alerte alpha
      if (!analysis.isAlphaAlert) {
        throw new Error('Le token ne passe pas le filtre Alpha (score <= 70)');
      }

      const message = this.formatMessage(token, analysis);
      const keyboard = this.createInlineKeyboard(token.address);

      const response = await this.apiClient.post<TelegramApiResponse>('/sendMessage', {
        chat_id: this.chatId,
        text: message,
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard,
        disable_web_page_preview: false,
      });

      if (!response.data.ok) {
        throw new Error(
          `Erreur Telegram API: ${response.data.description ?? 'Erreur inconnue'}`
        );
      }

      return true;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorMessage = error.response?.data?.description ?? error.message;
        throw new Error(`Erreur lors de l'envoi de la notification: ${errorMessage}`);
      }
      throw error;
    }
  }

  /**
   * Teste la connexion au bot Telegram
   * @returns {Promise<boolean>} True si la connexion est réussie
   * @throws {Error} Si la connexion échoue
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.apiClient.get<TelegramApiResponse>('/getMe');

      if (!response.data.ok) {
        throw new Error('Impossible de vérifier le bot Telegram');
      }

      return true;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorMessage = error.response?.data?.description ?? error.message;
        throw new Error(`Erreur de connexion Telegram: ${errorMessage}`);
      }
      throw error;
    }
  }
}

/**
 * Fonction utilitaire pour créer une instance du notifier
 * @param {NotifierConfig} config - Configuration du service
 * @returns {TelegramNotifier} Instance du notifier
 */
export function createNotifier(config: NotifierConfig): TelegramNotifier {
  return new TelegramNotifier(config);
}

