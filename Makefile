.PHONY: help install build start stop restart logs clean test docker-build docker-up docker-down docker-logs docker-restart docker-clean setup check

# Variables
DOCKER_COMPOSE = docker-compose
NPM = npm
NODE = node

# Vérifier que Docker est démarré
check-docker:
	@if ! docker info > /dev/null 2>&1; then \
		echo "$(RED)❌ Docker n'est pas démarré$(NC)"; \
		echo "$(YELLOW)   Démarrez Docker Desktop ou le daemon Docker$(NC)"; \
		exit 1; \
	fi

# Couleurs pour les messages
GREEN = \033[0;32m
YELLOW = \033[1;33m
RED = \033[0;31m
NC = \033[0m # No Color

##@ Général

help: ## Affiche cette aide
	@echo "$(GREEN)Gem Scanner - Commandes disponibles:$(NC)\n"
	@awk 'BEGIN {FS = ":.*##"; printf "\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  $(YELLOW)%-20s$(NC) %s\n", $$1, $$2 } /^##@/ { printf "\n$(GREEN)%s$(NC)\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

##@ Installation et Setup

install: ## Installe les dépendances npm
	@echo "$(GREEN)📦 Installation des dépendances...$(NC)"
	$(NPM) install

setup: ## Configuration initiale (copie .env.example si .env n'existe pas)
	@if [ ! -f .env ]; then \
		echo "$(YELLOW)📝 Création du fichier .env...$(NC)"; \
		cp .env.example .env 2>/dev/null || echo "$(RED)⚠️  .env.example non trouvé, créez .env manuellement$(NC)"; \
		echo "$(YELLOW)⚠️  N'oubliez pas de remplir les variables dans .env$(NC)"; \
	else \
		echo "$(GREEN)✅ Fichier .env existe déjà$(NC)"; \
	fi

check: ## Vérifie que les prérequis sont installés
	@echo "$(GREEN)🔍 Vérification des prérequis...$(NC)"
	@command -v node >/dev/null 2>&1 || { echo "$(RED)❌ Node.js n'est pas installé$(NC)"; exit 1; }
	@command -v npm >/dev/null 2>&1 || { echo "$(RED)❌ npm n'est pas installé$(NC)"; exit 1; }
	@echo "$(GREEN)✅ Node.js: $$(node --version)$(NC)"
	@echo "$(GREEN)✅ npm: $$(npm --version)$(NC)"
	@if [ -f .env ]; then \
		echo "$(GREEN)✅ Fichier .env trouvé$(NC)"; \
	else \
		echo "$(YELLOW)⚠️  Fichier .env non trouvé, exécutez 'make setup'$(NC)"; \
	fi

##@ Développement Local (sans Docker)

build: ## Compile TypeScript
	@echo "$(GREEN)🔨 Compilation TypeScript...$(NC)"
	$(NPM) run build

dev: ## Lance en mode développement (avec watch)
	@echo "$(GREEN)🚀 Démarrage en mode développement...$(NC)"
	$(NPM) run dev

start: build ## Lance en mode production (compile puis démarre)
	@echo "$(GREEN)🚀 Démarrage en mode production...$(NC)"
	$(NPM) start

type-check: ## Vérifie les types TypeScript
	@echo "$(GREEN)🔍 Vérification des types...$(NC)"
	$(NPM) run type-check

test: ## Lance les tests
	@echo "$(GREEN)🧪 Exécution des tests...$(NC)"
	$(NPM) test

test-watch: ## Lance les tests en mode watch
	@echo "$(GREEN)🧪 Tests en mode watch...$(NC)"
	$(NPM) run test:watch

test-ai: ## Teste l'intégration Ollama
	@echo "$(GREEN)🤖 Test de l'intégration IA...$(NC)"
	$(NPM) run test:ai

##@ Docker

docker-build: check-docker ## Construit les images Docker
	@echo "$(GREEN)🔨 Construction des images Docker...$(NC)"
	@$(DOCKER_COMPOSE) build

docker-up: check-docker docker-build ## Démarre les services Docker (build puis up)
	@echo "$(GREEN)🚀 Démarrage des services Docker...$(NC)"
	@$(DOCKER_COMPOSE) up -d
	@echo "$(YELLOW)⏳ Attente du démarrage d'Ollama (peut prendre 1-2 minutes)...$(NC)"
	@sleep 5
	@echo "$(GREEN)✅ Services démarrés$(NC)"
	@echo "$(YELLOW)📝 Utilisez 'make docker-logs' pour voir les logs$(NC)"

docker-down: ## Arrête les services Docker
	@echo "$(YELLOW)🛑 Arrêt des services Docker...$(NC)"
	$(DOCKER_COMPOSE) down

docker-restart: ## Redémarre les services Docker
	@echo "$(YELLOW)🔄 Redémarrage des services Docker...$(NC)"
	$(DOCKER_COMPOSE) restart

docker-logs: ## Affiche les logs Docker (tous les services)
	@echo "$(GREEN)📝 Logs des services Docker (100 dernières lignes):$(NC)"
	@$(DOCKER_COMPOSE) logs --tail=100 -f

docker-logs-all: ## Affiche tous les logs Docker (sans limite)
	@echo "$(GREEN)📝 Tous les logs des services Docker:$(NC)"
	@$(DOCKER_COMPOSE) logs -f

docker-logs-scanner: ## Affiche les logs du scanner uniquement (100 dernières lignes)
	@echo "$(GREEN)📝 Logs du scanner (100 dernières lignes):$(NC)"
	@$(DOCKER_COMPOSE) logs --tail=100 -f scanner

docker-logs-ollama: ## Affiche les logs d'Ollama uniquement (100 dernières lignes)
	@echo "$(GREEN)📝 Logs d'Ollama (100 dernières lignes):$(NC)"
	@$(DOCKER_COMPOSE) logs --tail=100 -f ollama

docker-ps: ## Affiche le statut des services Docker
	@echo "$(GREEN)📊 Statut des services:$(NC)"
	$(DOCKER_COMPOSE) ps

docker-stats: ## Affiche les statistiques d'utilisation des conteneurs
	@echo "$(GREEN)📊 Statistiques des conteneurs:$(NC)"
	docker stats gem-scanner-app gem-scanner-ollama

docker-clean: ## Nettoie les conteneurs, images et volumes Docker
	@echo "$(YELLOW)🧹 Nettoyage Docker...$(NC)"
	@read -p "⚠️  Cela supprimera les conteneurs, images et volumes. Continuer? [y/N] " -n 1 -r; \
	echo; \
	if [[ $$REPLY =~ ^[Yy]$$ ]]; then \
		$(DOCKER_COMPOSE) down -v; \
		docker system prune -f; \
		echo "$(GREEN)✅ Nettoyage terminé$(NC)"; \
	else \
		echo "$(YELLOW)❌ Nettoyage annulé$(NC)"; \
	fi

docker-logs-clean: ## Nettoie les logs Docker (force la rotation)
	@echo "$(YELLOW)🧹 Nettoyage des logs Docker...$(NC)"
	@echo "$(YELLOW)   Les logs seront automatiquement supprimés selon la configuration (max-size/max-file)$(NC)"
	@docker-compose down
	@docker-compose up -d
	@echo "$(GREEN)✅ Services redémarrés, anciens logs supprimés$(NC)"
	@echo "$(YELLOW)📊 Taille actuelle des logs:$(NC)"
	@docker inspect gem-scanner-app gem-scanner-ollama 2>/dev/null | grep -A 5 "LogPath" || echo "   (non disponible)"

docker-shell-scanner: ## Ouvre un shell dans le conteneur scanner
	@echo "$(GREEN)🐚 Ouverture d'un shell dans le conteneur scanner...$(NC)"
	$(DOCKER_COMPOSE) exec scanner sh

docker-shell-ollama: ## Ouvre un shell dans le conteneur Ollama
	@echo "$(GREEN)🐚 Ouverture d'un shell dans le conteneur Ollama...$(NC)"
	$(DOCKER_COMPOSE) exec ollama sh

docker-test-ollama: ## Teste la connexion à Ollama
	@echo "$(GREEN)🔍 Test de connexion à Ollama...$(NC)"
	@if curl -f http://127.0.0.1:11434/api/tags > /dev/null 2>&1 || curl -f http://localhost:11434/api/tags > /dev/null 2>&1; then \
		echo "$(GREEN)✅ Ollama est accessible$(NC)"; \
		curl -s http://127.0.0.1:11434/api/tags 2>/dev/null | head -20 || curl -s http://localhost:11434/api/tags 2>/dev/null | head -20; \
	else \
		echo "$(RED)❌ Ollama n'est pas accessible$(NC)"; \
		echo "$(YELLOW)   Vérifiez que le service est démarré: make docker-ps$(NC)"; \
	fi

docker-pull-model: ## Force le téléchargement du modèle Ollama
	@echo "$(GREEN)📥 Téléchargement du modèle qwen2.5:0.5b...$(NC)"
	$(DOCKER_COMPOSE) exec ollama ollama pull qwen2.5:0.5b

docker-list-models: ## Liste les modèles Ollama disponibles
	@echo "$(GREEN)📋 Modèles Ollama disponibles:$(NC)"
	$(DOCKER_COMPOSE) exec ollama ollama list

##@ Utilitaires

clean: ## Nettoie les fichiers de build
	@echo "$(YELLOW)🧹 Nettoyage des fichiers de build...$(NC)"
	rm -rf dist
	rm -rf node_modules/.cache
	@echo "$(GREEN)✅ Nettoyage terminé$(NC)"

clean-all: clean ## Nettoie tout (build + node_modules)
	@echo "$(YELLOW)🧹 Nettoyage complet...$(NC)"
	rm -rf node_modules
	@echo "$(GREEN)✅ Nettoyage complet terminé$(NC)"

##@ Démarrage rapide

run: ## Démarre le scanner localement (sans Docker)
	@echo "$(GREEN)🚀 Démarrage local...$(NC)"
	@make check
	@make install
	@make setup
	@echo "$(YELLOW)⚠️  Assurez-vous qu'Ollama est démarré localement: ollama serve$(NC)"
	@make dev

run-docker: ## Démarre le scanner avec Docker
	@echo "$(GREEN)🐳 Démarrage avec Docker...$(NC)"
	@make setup
	@make docker-up
	@echo "$(GREEN)✅ Scanner démarré avec Docker$(NC)"
	@echo "$(YELLOW)📝 Utilisez 'make docker-logs' pour voir les logs$(NC)"

run-all: check-docker ## Build et démarre Ollama + API (tout-en-un)
	@echo "$(GREEN)🚀 Build et démarrage complet (Ollama + API)...$(NC)"
	@make setup
	@echo "$(GREEN)🔨 Construction des images Docker...$(NC)"
	@$(DOCKER_COMPOSE) build
	@echo "$(GREEN)🚀 Démarrage des services (Ollama + Scanner)...$(NC)"
	@$(DOCKER_COMPOSE) up -d
	@echo "$(YELLOW)⏳ Attente du démarrage d'Ollama (peut prendre 1-2 minutes pour télécharger le modèle)...$(NC)"
	@echo "$(YELLOW)   Vérification de l'état des services...$(NC)"
	@sleep 3
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
		if curl -f http://127.0.0.1:11434/api/tags > /dev/null 2>&1 || curl -f http://localhost:11434/api/tags > /dev/null 2>&1; then \
			echo "$(GREEN)✅ Ollama est prêt$(NC)"; \
			break; \
		fi; \
		if [ $$i -eq 15 ]; then \
			echo "$(YELLOW)⚠️  Ollama prend plus de temps que prévu, mais continue...$(NC)"; \
			echo "$(YELLOW)   Vérifiez les logs avec: make docker-logs-ollama$(NC)"; \
		else \
			echo "   Attente... ($$i/15)"; \
			sleep 3; \
		fi; \
	done
	@echo ""
	@echo "$(GREEN)✅ Services démarrés:$(NC)"
	@$(DOCKER_COMPOSE) ps
	@echo ""
	@echo "$(GREEN)📝 Commandes utiles:$(NC)"
	@echo "   $(YELLOW)make docker-logs$(NC)        - Voir tous les logs"
	@echo "   $(YELLOW)make docker-logs-scanner$(NC) - Logs du scanner uniquement"
	@echo "   $(YELLOW)make docker-logs-ollama$(NC)  - Logs d'Ollama uniquement"
	@echo "   $(YELLOW)make docker-ps$(NC)          - Statut des services"
	@echo "   $(YELLOW)make docker-down$(NC)       - Arrêter les services"

run-model: check-docker ## Build et démarre uniquement Ollama (modèle IA)
	@echo "$(GREEN)🤖 Build et démarrage d'Ollama uniquement...$(NC)"
	@echo "$(GREEN)🔨 Construction de l'image Ollama...$(NC)"
	@$(DOCKER_COMPOSE) build ollama
	@echo "$(GREEN)🚀 Démarrage d'Ollama...$(NC)"
	@$(DOCKER_COMPOSE) up -d ollama
	@echo "$(YELLOW)⏳ Attente du démarrage d'Ollama (peut prendre 1-2 minutes pour télécharger le modèle)...$(NC)"
	@sleep 3
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
		if curl -f http://127.0.0.1:11434/api/tags > /dev/null 2>&1 || curl -f http://localhost:11434/api/tags > /dev/null 2>&1; then \
			echo "$(GREEN)✅ Ollama est prêt et accessible sur http://localhost:11434$(NC)"; \
			echo "$(GREEN)📋 Modèles disponibles:$(NC)"; \
			curl -s http://127.0.0.1:11434/api/tags 2>/dev/null | grep -o '"name":"[^"]*"' | head -5 || curl -s http://localhost:11434/api/tags 2>/dev/null | grep -o '"name":"[^"]*"' | head -5 || echo "   (en cours de téléchargement...)"; \
			break; \
		fi; \
		if [ $$i -eq 15 ]; then \
			echo "$(YELLOW)⚠️  Ollama prend plus de temps que prévu$(NC)"; \
			echo "$(YELLOW)   Vérifiez les logs avec: make docker-logs-ollama$(NC)"; \
		else \
			echo "   Attente... ($$i/15)"; \
			sleep 3; \
		fi; \
	done
	@echo ""
	@echo "$(GREEN)📝 Commandes utiles:$(NC)"
	@echo "   $(YELLOW)make docker-logs-ollama$(NC)  - Voir les logs d'Ollama"
	@echo "   $(YELLOW)make docker-ps$(NC)          - Statut des services"
	@echo "   $(YELLOW)make docker-test-ollama$(NC)  - Tester la connexion"
	@echo "   $(YELLOW)docker-compose stop ollama$(NC) - Arrêter Ollama"

run-api: check-docker ## Build et démarre uniquement l'API (scanner)
	@echo "$(GREEN)🚀 Build et démarrage de l'API uniquement...$(NC)"
	@make setup
	@echo "$(GREEN)🔨 Construction de l'image Scanner...$(NC)"
	@$(DOCKER_COMPOSE) build scanner
	@echo "$(YELLOW)⚠️  Note: L'API nécessite Ollama pour fonctionner$(NC)"
	@echo "$(YELLOW)   Assurez-vous qu'Ollama est démarré (make run-model) ou utilisez OLLAMA_API_URL dans .env$(NC)"
	@if ! curl -f http://127.0.0.1:11434/api/tags > /dev/null 2>&1 && ! curl -f http://localhost:11434/api/tags > /dev/null 2>&1; then \
		echo "$(YELLOW)⚠️  Ollama ne semble pas être accessible sur localhost:11434$(NC)"; \
		echo "$(YELLOW)   L'API peut échouer si Ollama n'est pas disponible$(NC)"; \
		echo "$(YELLOW)   Démarrez Ollama avec: make run-model$(NC)"; \
	fi
	@echo "$(GREEN)🚀 Démarrage du scanner...$(NC)"
	@$(DOCKER_COMPOSE) up -d scanner
	@sleep 2
	@echo ""
	@echo "$(GREEN)✅ Scanner démarré$(NC)"
	@$(DOCKER_COMPOSE) ps scanner
	@echo ""
	@echo "$(GREEN)📝 Commandes utiles:$(NC)"
	@echo "   $(YELLOW)make docker-logs-scanner$(NC) - Voir les logs du scanner"
	@echo "   $(YELLOW)make docker-ps$(NC)          - Statut des services"
	@echo "   $(YELLOW)docker-compose stop scanner$(NC) - Arrêter le scanner"

##@ Par défaut

.DEFAULT_GOAL := help

