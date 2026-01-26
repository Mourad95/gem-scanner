/**
 * Point d'entrée principal du scanner de tokens Solana
 * @module index
 */

import WebSocket from 'ws';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { loadSettings, validateSettings, type AppSettings } from './config/settings.js';
import { validateToken, fetchSolPrice, type TokenData } from './services/analyzer.js';
import { createNotifier } from './services/notifier.js';
import { fetchTokenHolders, type HolderData } from './services/holderService.js';

// Charger les variables d'environnement
dotenv.config();

/**
 * Statistiques de performance
 */
interface PerformanceStats {
  totalProcessed: number;
  totalAlerts: number;
  totalErrors: number;
  avgProcessingTime: number;
  minProcessingTime: number;
  maxProcessingTime: number;
  times: number[];
}

/**
 * Logger de performance
 */
class PerformanceLogger {
  private stats: PerformanceStats = {
    totalProcessed: 0,
    totalAlerts: 0,
    totalErrors: 0,
    avgProcessingTime: 0,
    minProcessingTime: Infinity,
    maxProcessingTime: 0,
    times: [],
  };

  /**
   * Enregistre une mesure de performance
   * @param {number} processingTime - Temps de traitement en ms
   * @param {boolean} isAlert - Si une alerte a été envoyée
   * @param {boolean} isError - Si une erreur s'est produite
   */
  record(processingTime: number, isAlert: boolean, isError: boolean): void {
    this.stats.totalProcessed++;
    if (isAlert) this.stats.totalAlerts++;
    if (isError) this.stats.totalErrors++;

    this.stats.times.push(processingTime);
    this.stats.minProcessingTime = Math.min(this.stats.minProcessingTime, processingTime);
    this.stats.maxProcessingTime = Math.max(this.stats.maxProcessingTime, processingTime);

    // Calculer la moyenne sur les 100 dernières mesures
    const recentTimes = this.stats.times.slice(-100);
    this.stats.avgProcessingTime =
      recentTimes.reduce((sum, time) => sum + time, 0) / recentTimes.length;

    // Afficher le résultat avec couleur selon le temps
    const color = processingTime < 500 ? chalk.green : processingTime < 1000 ? chalk.yellow : chalk.red;
    const emoji = processingTime < 500 ? '✅' : processingTime < 1000 ? '⚠️' : '❌';
    
    console.log(
      `${emoji} ${color(`[${processingTime.toFixed(0)}ms]`)} ${chalk.gray('→')} ` +
      `${isAlert ? chalk.cyan('ALERTE ENVOYÉE') : chalk.gray('Pas d\'alerte')} ` +
      `${isError ? chalk.red('(ERREUR)') : ''}`
    );
  }

  /**
   * Affiche les statistiques globales
   */
  printStats(): void {
    console.log('\n' + chalk.bold('📊 Statistiques de Performance:'));
    console.log(`  Total traité: ${chalk.cyan(this.stats.totalProcessed)}`);
    console.log(`  Alertes envoyées: ${chalk.green(this.stats.totalAlerts)}`);
    console.log(`  Erreurs: ${chalk.red(this.stats.totalErrors)}`);
    console.log(`  Temps moyen: ${this.getColorForTime(this.stats.avgProcessingTime)(`${this.stats.avgProcessingTime.toFixed(0)}ms`)}`);
    console.log(`  Temps min: ${chalk.green(`${this.stats.minProcessingTime.toFixed(0)}ms`)}`);
    console.log(`  Temps max: ${chalk.red(`${this.stats.maxProcessingTime.toFixed(0)}ms`)}`);
    
    const under500 = this.stats.times.filter(t => t < 500).length;
    const percentage = (under500 / this.stats.times.length) * 100;
    console.log(`  < 500ms: ${this.getColorForPercentage(percentage)(`${percentage.toFixed(1)}%`)} (${under500}/${this.stats.times.length})`);
  }

  private getColorForTime(time: number): (text: string) => string {
    if (time < 500) return chalk.green;
    if (time < 1000) return chalk.yellow;
    return chalk.red;
  }

  private getColorForPercentage(percentage: number): (text: string) => string {
    if (percentage >= 90) return chalk.green;
    if (percentage >= 70) return chalk.yellow;
    return chalk.red;
  }
}

/**
 * Scanner principal
 */
class TokenScanner {
  private settings: AppSettings;
  private notifier: ReturnType<typeof createNotifier>;
  private performanceLogger: PerformanceLogger;
  private ws: WebSocket | null = null;
  private solPriceCache: number | null = null;
  private solPriceCacheTime: number = 0;
  private readonly SOL_PRICE_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  constructor(settings: AppSettings) {
    this.settings = settings;
    this.notifier = createNotifier({ telegram: this.settings.telegram });
    this.performanceLogger = new PerformanceLogger();
  }

  /**
   * Initialise le scanner (précharge le prix SOL)
   */
  async initialize(): Promise<void> {
    console.log(chalk.blue('🚀 Initialisation du scanner...'));
    
    try {
      // Précharger le prix SOL pour éviter les latences
      this.solPriceCache = await fetchSolPrice();
      this.solPriceCacheTime = Date.now();
      console.log(chalk.green(`✅ Prix SOL préchargé: $${this.solPriceCache.toFixed(2)}`));
    } catch (error) {
      console.warn(chalk.yellow('⚠️ Impossible de précharger le prix SOL, utilisation du fallback'));
      this.solPriceCache = 100; // Fallback
    }

    // Tester la connexion Telegram
    try {
      await this.notifier.testConnection();
      console.log(chalk.green('✅ Connexion Telegram vérifiée'));
    } catch (error) {
      console.error(chalk.red('❌ Erreur de connexion Telegram:'), error);
      throw error;
    }
  }

  /**
   * Récupère le prix SOL (avec cache)
   */
  private async getSolPrice(): Promise<number> {
    const now = Date.now();
    if (this.solPriceCache && now - this.solPriceCacheTime < this.SOL_PRICE_CACHE_DURATION) {
      return this.solPriceCache;
    }

    try {
      this.solPriceCache = await fetchSolPrice();
      this.solPriceCacheTime = now;
      return this.solPriceCache;
    } catch (error) {
      // Utiliser le cache même s'il est expiré
      if (this.solPriceCache) {
        return this.solPriceCache;
      }
      return 100; // Fallback
    }
  }

  /**
   * Normalise une valeur (détection automatique si division nécessaire)
   * @param {unknown} value - Valeur à normaliser
   * @returns {number} Valeur normalisée
   */
  private normalizeValue(value: unknown): number {
    if (typeof value === 'number') {
      // Si la valeur > 1e9, c'est probablement en lamports, diviser
      return value > 1_000_000_000 ? value / 1e9 : value;
    }
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      return parsed > 1_000_000_000 ? parsed / 1e9 : parsed;
    }
    return 0;
  }

  /**
   * Normalise les réserves (convertit en unités réelles avec détection automatique)
   * @param {unknown} reserves - Réserves brutes du WebSocket
   * @returns {TokenData['reserves']} Réserves normalisées
   */
  private normalizeReserves(reserves: unknown): TokenData['reserves'] {
    if (!reserves || typeof reserves !== 'object') {
      return undefined;
    }

    const r = reserves as Record<string, unknown>;
    const vSolReserves = this.normalizeValue(r['vSolReserves'] || r['virtualSolReserves']);
    const tokenReserves = this.normalizeValue(r['tokenReserves'] || r['virtualTokenReserves']);

    return {
      vSolReserves,
      tokenReserves,
    };
  }

  /**
   * Valide qu'une adresse Solana est valide (Base58, 32-44 caractères)
   * @param {string} address - Adresse à valider
   * @returns {boolean} True si l'adresse est valide
   */
  private isValidSolanaAddress(address: string): boolean {
    if (!address || typeof address !== 'string') {
      return false;
    }

    // Longueur typique d'une adresse Solana (32-44 caractères)
    if (address.length < 32 || address.length > 44) {
      return false;
    }

    // Vérifier que c'est du Base58 (pas de 0, O, I, l)
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    return base58Regex.test(address);
  }

  /**
   * Traite un token reçu via WebSocket
   * @param {TokenData} tokenData - Données du token
   */
  async processToken(tokenData: TokenData): Promise<void> {
    const startTime = Date.now();
    let isAlert = false;
    let isError = false;

    try {
      // Valider l'adresse Solana avant traitement
      if (!this.isValidSolanaAddress(tokenData.address)) {
        console.warn(
          chalk.yellow(`⚠️ Adresse Solana invalide ignorée: ${tokenData.address}`)
        );
        return;
      }

      // Normaliser les réserves (convertir en unités réelles avec détection automatique)
      if (tokenData.reserves) {
        tokenData.reserves = this.normalizeReserves(tokenData.reserves);
      }

      // Créer un AbortController pour timeout de 800ms sur fetchTokenHolders
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
      }, 800);

      // Récupérer le prix SOL et les holders en parallèle pour optimiser
      const [solPrice, holders] = await Promise.all([
        this.getSolPrice(),
        fetchTokenHolders(tokenData.address, { 
          solana: this.settings.solana,
          limit: 10, // Top 10 seulement pour performance
          signal: abortController.signal,
        })
          .then((result) => {
            clearTimeout(timeoutId);
            return result;
          })
          .catch((error: unknown) => {
            clearTimeout(timeoutId);
            
            // Si c'est un timeout (AbortError), continuer sans holders
            if (error instanceof Error && error.name === 'AbortError') {
              console.warn(
                chalk.yellow(`⏱️ Timeout holders (800ms) pour ${tokenData.address}, continuation sans Shadow Scan`)
              );
            } else {
              // Autre erreur
              console.warn(
                chalk.yellow(`⚠️ Impossible de récupérer les holders pour ${tokenData.address}: ${error instanceof Error ? error.message : 'Erreur inconnue'}`)
              );
            }
            return [] as HolderData[];
          }),
      ]);

      // Analyser le token avec les holders (Shadow Scan activé)
      const analysis = await validateToken(tokenData, {
        solPriceUsd: solPrice,
        holders: holders.length > 0 ? holders : undefined,
      });

      // Détecter les scams via holders (score très bas à cause des pénalités holders)
      const isScamDetected = 
        analysis.score < 30 && 
        analysis.breakdown.holdersScore < 0 &&
        (analysis.breakdown.holdersScore <= -40 || analysis.reasons.some(r => r.includes('CRITIQUE') || r.includes('dump massif')));

      if (isScamDetected) {
        console.log(
          chalk.red.bold(`\n[SCAM DETECTED] `) +
          chalk.red(`${tokenData.address} - Score: ${analysis.score}/100`) +
          chalk.gray(` (Holders: ${analysis.breakdown.holdersScore}pts)`)
        );
        // Afficher les raisons du scam
        analysis.reasons
          .filter(r => r.includes('🚨') || r.includes('CRITIQUE') || r.includes('dump'))
          .forEach(reason => {
            console.log(chalk.red(`  └─ ${reason}`));
          });
      }

      // Si c'est une alerte alpha, envoyer la notification
      if (analysis.isAlphaAlert) {
        await this.notifier.sendAlert(tokenData, analysis);
        isAlert = true;
      }

      const processingTime = Date.now() - startTime;
      this.performanceLogger.record(processingTime, isAlert, isError);

      // Avertir si le temps dépasse 500ms
      if (processingTime >= 500) {
        console.warn(
          chalk.yellow(`⚠️ Temps de traitement élevé: ${processingTime}ms pour ${tokenData.address}`)
        );
      }
    } catch (error) {
      const processingTime = Date.now() - startTime;
      isError = true;
      this.performanceLogger.record(processingTime, false, true);
      
      console.error(
        chalk.red(`❌ Erreur lors du traitement du token ${tokenData.address}:`),
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Parse un message pumpportal.fun au format 'subscribeNewToken'
   * @param {unknown} message - Message brut du WebSocket
   * @returns {TokenData | null} Données du token ou null si format invalide
   */
  private parsePumpPortalMessage(message: unknown): TokenData | null {
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

  /**
   * Démarre la connexion WebSocket vers pumpportal.fun
   */
  async start(): Promise<void> {
    console.log(chalk.blue('🔌 Connexion au WebSocket pumpportal.fun...'));

    const wsUrl = process.env['WEBSOCKET_URL'] || 'wss://pumpportal.fun/api/data';

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
          console.log(chalk.green('✅ WebSocket connecté à pumpportal.fun'));
          console.log(chalk.blue('👂 En attente de nouveaux tokens...\n'));
          resolve();
        });

        this.ws.on('message', async (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());
            
            // Parser le message au format pumpportal.fun
            const tokenData = this.parsePumpPortalMessage(message);
            
            if (!tokenData || !tokenData.address) {
              // Ignorer les messages qui ne sont pas des nouveaux tokens
              return;
            }

            // Traiter le token de manière asynchrone (non-bloquant)
            this.processToken(tokenData).catch((error) => {
              console.error(chalk.red('Erreur dans processToken:'), error);
            });
          } catch (error) {
            // Ignorer les erreurs de parsing silencieusement (peut être un message de heartbeat, etc.)
            if (error instanceof SyntaxError) {
              // Message non-JSON, probablement un heartbeat
              return;
            }
            console.error(chalk.red('Erreur lors du parsing du message WebSocket:'), error);
          }
        });

        this.ws.on('error', (error) => {
          console.error(chalk.red('❌ Erreur WebSocket:'), error);
          reject(error);
        });

        this.ws.on('close', () => {
          console.log(chalk.yellow('⚠️ WebSocket fermé, reconnexion...'));
          // Reconnexion automatique après 5 secondes
          setTimeout(() => {
            this.start().catch(reject);
          }, 5000);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Arrête le scanner
   */
  stop(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.performanceLogger.printStats();
  }
}

/**
 * Point d'entrée principal
 */
async function main(): Promise<void> {
  try {
    console.log(chalk.bold.blue('\n╔══════════════════════════════════════╗'));
    console.log(chalk.bold.blue('║     GEM SCANNER - Solana Tokens      ║'));
    console.log(chalk.bold.blue('╚══════════════════════════════════════╝\n'));

    // Charger et valider la configuration
    const settings = loadSettings();
    validateSettings(settings);

    // Créer et initialiser le scanner
    const scanner = new TokenScanner(settings);
    await scanner.initialize();

    // Gérer l'arrêt propre
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\n\n⚠️ Arrêt du scanner...'));
      scanner.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log(chalk.yellow('\n\n⚠️ Arrêt du scanner...'));
      scanner.stop();
      process.exit(0);
    });

    // Démarrer le scanner
    await scanner.start();
  } catch (error) {
    console.error(chalk.red('❌ Erreur fatale:'), error);
    process.exit(1);
  }
}

// Lancer l'application
main().catch((error) => {
  console.error(chalk.red('Erreur non gérée:'), error);
  process.exit(1);
});

