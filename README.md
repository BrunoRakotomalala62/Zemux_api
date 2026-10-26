# Zemux API

API REST sécurisée et déployable sur Vercel pour utiliser le modèle multimodal gratuit de ZenMux :

- **Modèle verrouillé côté serveur :** `z-ai/glm-4.6v-flash-free`
- **Entrées :** texte et jusqu'à quatre images PNG/JPEG/WebP/GIF
- **Conversation :** continuité par `uid`
- **Compatibilité :** GET simple et POST JSON recommandé
- **Secrets :** la clé ZenMux reste exclusivement dans `ZENMUX_API_KEY`

Le modèle est volontairement fixé dans le code : un appelant public ne peut pas sélectionner par erreur un modèle payant.

## Route

### Texte avec GET

```text
GET /api?zemux=Bonjour&uid=123
```

Les alias `zenmux`, `message` et `prompt` sont également acceptés :

```bash
curl -G "https://YOUR_PROJECT.vercel.app/api" \
  --data-urlencode "zemux=Explique la photosynthèse" \
  --data-urlencode "uid=123"
```

Réutilisez le même `uid` pour continuer la conversation.

### Image par URL HTTPS

```bash
curl -G "https://YOUR_PROJECT.vercel.app/api" \
  --data-urlencode "zemux=Décris cette image" \
  --data-urlencode "image=https://example.com/photo.jpg" \
  --data-urlencode "uid=123"
```

Les URL privées, locales ou non HTTPS sont refusées. L'API télécharge l'image de manière contrôlée, vérifie son type et sa signature, puis transmet une data URL à ZenMux.

### POST JSON recommandé

```bash
curl -X POST "https://YOUR_PROJECT.vercel.app/api" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Compare ces images",
    "uid": "123",
    "reset": true,
    "images": [
      "data:image/jpeg;base64,...",
      "https://example.com/photo-2.png"
    ]
  }'
```

Jusqu'à quatre images sont acceptées. POST évite les limites de longueur des URL.

### Réinitialiser une conversation

```text
GET /api?uid=123&reset=1
```

## Réponse JSON

```json
{
  "ok": true,
  "uid": "123",
  "model": "z-ai/glm-4.6v-flash-free",
  "answer": "Bonjour !",
  "tokens": {
    "request": {
      "input": 15,
      "cached_input": 0,
      "output": 20,
      "reasoning": 10,
      "total": 35
    }
  },
  "billing": {
    "catalog_price": "free",
    "reported_cost_metadata": "0.0000"
  },
  "conversation": {
    "message_count": 2,
    "persistent": false,
    "backend": "memory"
  }
}
```

Les tokens de raisonnement sont inclus dans les tokens de sortie et ne sont pas additionnés une deuxième fois. Les champs `usage.cost` fournis par ZenMux sont relayés comme métadonnées techniques, pas comme preuve de facturation. La disponibilité, les limites et le tarif final restent contrôlés par ZenMux.

## Déploiement Vercel

1. Importez le dépôt GitHub `BrunoRakotomalala62/Zemux_api` dans Vercel.
2. Dans **Settings → Environment Variables**, ajoutez :

```text
ZENMUX_API_KEY=votre_nouvelle_cle
```

3. Activez cette variable pour Production, Preview et Development.
4. Redéployez le projet.
5. Vérifiez `https://VOTRE-DOMAINE.vercel.app/api`.

### Important : rotation de la clé

Une clé partagée dans une conversation ou un message doit être considérée comme compromise. Révoquez-la dans ZenMux, créez-en une nouvelle, puis placez uniquement la nouvelle valeur dans Vercel. Ne l'ajoutez jamais à GitHub, au JavaScript du navigateur ou à `vercel.json`.

Dans le tableau de bord ZenMux, il est recommandé de limiter la clé à :

- modèle autorisé : `z-ai/glm-4.6v-flash-free` uniquement ;
- RPM/TPM adaptés au trafic du site ;
- limite de crédit minimale.

L'API ajoute aussi une limite locale par défaut de 20 requêtes par minute et par adresse IP. Cette limite en mémoire est un garde-fou, pas un remplacement des limites configurées chez ZenMux.

## Variables d'environnement

| Variable | Obligatoire | Défaut | Description |
|---|---:|---|---|
| `ZENMUX_API_KEY` | oui | — | Clé secrète ZenMux |
| `ZENMUX_API_BASE_URL` | non | `https://zenmux.ai/api/v1` | API OpenAI-compatible |
| `DEFAULT_REASONING_EFFORT` | non | `low` | `low`, `medium` ou `high` |
| `MAX_COMPLETION_TOKENS` | non | `2048` | Limite de sortie |
| `UPSTREAM_TIMEOUT_MS` | non | `50000` | Délai ZenMux |
| `MAX_IMAGES` | non | `4` | Images par requête |
| `MAX_IMAGE_BYTES` | non | `4194304` | Taille maximale par image |
| `RATE_LIMIT_PER_MINUTE` | non | `20` | Garde-fou par IP |
| `ALLOWED_ORIGINS` | non | `*` | Origines CORS séparées par virgules |
| `ZEMUX_API_TOKEN` | non | vide | Protection facultative de l'API publique |
| `UPSTASH_REDIS_REST_URL` | non | vide | Persistance des conversations |
| `UPSTASH_REDIS_REST_TOKEN` | non | vide | Jeton Upstash |

Si `ZEMUX_API_TOKEN` est défini, les clients doivent envoyer `Authorization: Bearer ...` ou `X-API-Key`. Pour un site public appelant directement l'API depuis le navigateur, laissez cette variable vide ou placez un proxy serveur devant l'API.

## Développement local

```bash
cp .env.example .env
# renseigner ZENMUX_API_KEY dans l'environnement du shell
npm run check
npm test
npm run dev
```

L'API locale écoute alors sur `http://localhost:3000/api`.

## Sécurité

- aucune clé dans le dépôt ;
- modèle gratuit verrouillé côté serveur ;
- validation stricte de `uid` ;
- CORS configurable ;
- protection facultative de la route ;
- blocage SSRF des images privées/locales ;
- contrôle des signatures PNG/JPEG/WebP/GIF ;
- limites de taille, nombre d'images, historique et débit ;
- délais sur ZenMux, Redis et téléchargement d'images ;
- réponses non mises en cache.

Le schéma complet est disponible dans [`openapi.yaml`](./openapi.yaml).
