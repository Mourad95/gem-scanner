# Dockerfile pour l'application Gem Scanner
FROM node:20-alpine

# Installer les dépendances système nécessaires
RUN apk add --no-cache \
    python3 \
    make \
    g++

# Créer le répertoire de travail
WORKDIR /app

# Copier les fichiers de configuration
COPY package*.json ./
COPY tsconfig.json ./

# Installer les dépendances (y compris devDependencies pour le build)
RUN npm ci

# Copier le code source
COPY src/ ./src/

# Compiler TypeScript (les fichiers de test sont exclus via tsconfig.json)
RUN npm run build

# Nettoyer les devDependencies après le build pour réduire la taille de l'image
RUN npm prune --production

# Créer un utilisateur non-root pour la sécurité
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Changer la propriété des fichiers
RUN chown -R nodejs:nodejs /app

# Passer à l'utilisateur non-root
USER nodejs

# Exposer le port (si nécessaire pour monitoring)
EXPOSE 3000

# Commande de démarrage
CMD ["node", "dist/index.js"]

