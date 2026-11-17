# ClipForge — version publique

Le site complet : n'importe qui ouvre le lien, colle un lien YouTube/Twitch (ou dépose un fichier), génère ses clips et les télécharge.

```
navigateur du visiteur                      ton serveur (ce dossier)
─────────────────────                      ─────────────────────────
transcription (Whisper)                    import YouTube/Twitch (yt-dlp)
éditeur, sous-titres, gameplay      ⇄      Claude : moments, titres, hashtags,
rendu MP4 + couverture + zip               vérification des sous-titres
```

Le gros du travail (transcription, rendu vidéo) tourne dans le navigateur de chaque visiteur : le serveur reste léger et peu cher.

## 1. Mettre en ligne (Render, sans ligne de commande)

1. Crée un compte sur **github.com**, puis un dépôt (bouton **New**), par exemple `clipforge`.
2. Dans le dépôt : **Add file → Upload files**, glisse **tout le contenu** de ce dossier (sauf `node_modules`), puis **Commit**.
3. Crée un compte sur **render.com** → **New → Web Service** → connecte ton GitHub → choisis le dépôt.
4. Render détecte le `Dockerfile` (Runtime : **Docker**). Choisis une offre (la gratuite suffit pour tester, mais elle se met en veille et elle est lente au réveil).
5. Dans **Environment**, ajoute :
   - `ANTHROPIC_API_KEY` = ta clé créée sur **console.anthropic.com** (facturée à l'usage — sans clé, le site marche mais choisit les moments et les hashtags automatiquement, sans Claude).
6. **Create Web Service**. Au bout de quelques minutes tu obtiens une adresse `https://clipforge-xxxx.onrender.com` : c'est le lien à envoyer.

Toute autre plateforme qui accepte un `Dockerfile` marche aussi (Railway, Fly.io, un VPS…).

## 2. Tester sur ton Mac avant

```bash
brew install node yt-dlp ffmpeg deno
cd clipforge-server
npm install
cp .env.example .env      # mets ta clé ANTHROPIC_API_KEY dedans
npm run dev               # puis ouvre http://localhost:3000
```

## 3. Réglages (variables d'environnement)

| Variable | Défaut | Rôle |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Active Claude (moments, titres, hashtags, vérification) |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Modèle utilisé |
| `MAX_MINUTES` | 180 | Durée max d'une vidéo importée |
| `DL_PER_HOUR` | 6 | Imports par visiteur et par heure |
| `AI_PER_HOUR` | 60 | Appels Claude par visiteur et par heure |
| `MAX_PARALLEL` | 2 | Imports simultanés sur le serveur |
| `YTDLP_PROXY` | — | Proxy si YouTube bloque l'IP du serveur |
| `YTDLP_COOKIES_FILE` | — | Fichier cookies.txt (même usage) |

Les vidéos importées sont supprimées du serveur au bout d'1 h.

## 4. À savoir avant de partager le lien

- **YouTube bloque souvent les serveurs cloud** (« Sign in to confirm you're not a bot »). Si ça arrive, il faut un proxy résidentiel (`YTDLP_PROXY`, payant) — c'est ce que font les gros outils comme Klap. Le dépôt de fichier marche toujours.
- **Coûts** : l'hébergement + chaque appel à Claude est facturé sur ta clé (environ une dizaine d'appels par vidéo). Les limites par heure évitent qu'un seul visiteur vide ton crédit.
- **Légal** : les conditions de YouTube interdisent en principe de télécharger des vidéos en dehors de leurs outils, et republier le contenu d'un autre créateur sans autorisation peut enfreindre ses droits. En ouvrant l'outil au public, c'est toi qui en es responsable : ajoute des conditions d'utilisation (« uniquement des vidéos dont vous avez les droits ») et retire les contenus sur demande.
- Fonctionne au mieux sur **Chrome** (ordinateur). Garder l'onglet visible pendant le rendu.
