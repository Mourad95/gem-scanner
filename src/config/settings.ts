/**
 * Configuration par défaut de l'application
 * @module config/settings
 */

/**
 * Interface pour la configuration Solana
 */
export interface SolanaConfig {
  rpcUrl: string;
  rpcKey: string;
}

/**
 * Interface pour la configuration Telegram
 */
export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/**
 * Interface pour les seuils et paramètres de configuration
 */
export interface DefaultSettings {
  minBondingCurve: number;
  maxBondingCurve: number;
  maxDevHolding: number;
  minDevHolding: number;
  minLiquidity: number;
  maxLiquidity: number;
  minMarketCap: number;
  maxMarketCap: number;
  scanInterval: number;
  maxRetries: number;
  retryDelay: number;
  wsReconnectInterval: number;
  wsMaxReconnectAttempts: number;
  notificationCooldown: number;
  maxNotificationsPerHour: number;
}

/**
 * Interface complète de la configuration de l'application
 */
export interface AppSettings extends DefaultSettings {
  solana: SolanaConfig;
  telegram: TelegramConfig;
}

/**
 * Seuils et paramètres de configuration par défaut
 */
export const defaultSettings: DefaultSettings = {
  // Seuils de bonding curve
  minBondingCurve: 10,
  maxBondingCurve: 1000,

  // Seuils de détention des développeurs
  maxDevHolding: 5,
  minDevHolding: 0,

  // Seuils de liquidité
  minLiquidity: 1000,
  maxLiquidity: 1000000,

  // Seuils de capitalisation
  minMarketCap: 10000,
  maxMarketCap: 10000000,

  // Paramètres de scan
  scanInterval: 5000, // ms
  maxRetries: 3,
  retryDelay: 1000, // ms

  // Paramètres WebSocket
  wsReconnectInterval: 5000, // ms
  wsMaxReconnectAttempts: 10,

  // Paramètres de notification
  notificationCooldown: 60000, // ms (1 minute)
  maxNotificationsPerHour: 20,
};

/**
 * Charge et valide la configuration depuis les variables d'environnement
 * @returns {AppSettings} Configuration validée
 */
export function loadSettings(): AppSettings {
  return {
    ...defaultSettings,
    solana: {
      rpcUrl: process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com',
      rpcKey: process.env['SOLANA_RPC_KEY'] ?? '',
    },
    telegram: {
      botToken: process.env['TELEGRAM_BOT_TOKEN'] ?? '',
      chatId: process.env['TELEGRAM_CHAT_ID'] ?? '',
    },
  };
}

/**
 * Valide que les paramètres critiques sont configurés
 * @param {AppSettings} settings - Configuration à valider
 * @throws {Error} Si des paramètres critiques sont manquants
 */
export function validateSettings(settings: AppSettings): void {
  const errors: string[] = [];

  if (!settings.solana.rpcUrl) {
    errors.push('SOLANA_RPC_URL est requis');
  }

  if (!settings.telegram.botToken) {
    errors.push('TELEGRAM_BOT_TOKEN est requis');
  }

  if (!settings.telegram.chatId) {
    errors.push('TELEGRAM_CHAT_ID est requis');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration invalide: ${errors.join(', ')}`);
  }
}

