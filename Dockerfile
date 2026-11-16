# Preview container for Cloud Run (see deploy/README-preview.md).
# Client-side VITE_* values are passed as build args; never pass VITE_APPCHECK_DEBUG_TOKEN.
FROM node:22-bookworm-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.29.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_STORAGE_BUCKET
ARG VITE_FIREBASE_MESSAGING_SENDER_ID
ARG VITE_FIREBASE_APP_ID
ARG VITE_RECAPTCHA_ENTERPRISE_SITE_KEY
ARG VITE_CLOUD_MODEL
# Belt and braces: make sure no App Check debug token can reach the bundle.
ENV VITE_APPCHECK_DEBUG_TOKEN=""
RUN rm -f .env .env.local .env.*.local && pnpm build
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", ".output/server/index.mjs"]
