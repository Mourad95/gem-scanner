# Gem Scanner

Scanner de tokens Solana avec notifications Telegram.

## Prérequis

- Node.js >= 18.0.0
- npm ou yarn

## Installation

```bash
npm install
```

## Configuration

1. Copiez le fichier `.env.example` vers `.env` :
```bash
cp .env.example .env
```

2. Remplissez les variables d'environnement dans `.env` :
   - `SOLANA_RPC_URL` : URL de votre endpoint RPC Solana
   - `SOLANA_RPC_KEY` : Clé API RPC (optionnelle selon le provider)
   - `TELEGRAM_BOT_TOKEN` : Token de votre bot Telegram
   - `TELEGRAM_CHAT_ID` : ID du chat où envoyer les notifications
   - `WEBSOCKET_URL` : URL du WebSocket pour recevoir les tokens (optionnel, défaut: wss://api.pump.fun/ws)

## Utilisation

```bash
# Mode développement (avec watch)
npm run dev

# Mode production
npm start

# Compilation TypeScript
npm run build

# Vérification des types
npm run type-check
```

## Performance

Le scanner est optimisé pour traiter les tokens en moins de 500ms entre la réception WebSocket et l'envoi de la notification Telegram.

**Optimisations implémentées :**
- Préchargement du prix SOL au démarrage
- Cache du prix SOL (5 minutes)
- Traitement asynchrone non-bloquant
- Logger de performance en temps réel avec statistiques

**Statistiques affichées :**
- Temps de traitement par token
- Pourcentage de tokens traités en < 500ms
- Temps moyen, min et max
- Nombre d'alertes envoyées

## Structure du projet

```
gem-scanner/
├── src/
│   ├── config/
│   │   └── settings.ts    # Configuration et seuils (TypeScript)
│   └── index.ts           # Point d'entrée (à créer)
├── dist/                  # Fichiers compilés (généré)
├── .env                   # Variables d'environnement (non versionné)
├── .env.example           # Exemple de configuration
├── tsconfig.json          # Configuration TypeScript
├── package.json
└── README.md
```

## Configuration par défaut

Les seuils par défaut sont définis dans `src/config/settings.ts` :
- `minBondingCurve`: 10
- `maxDevHolding`: 5
- Et autres paramètres configurables

## Technologies

- **TypeScript** : Typage strict pour la sécurité et la maintenabilité
- **ESM** : Modules ES6 natifs
- **tsx** : Exécution TypeScript sans compilation préalable en développement

