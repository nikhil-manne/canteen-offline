FROM node:22-bookworm-slim
WORKDIR /workspace
COPY package.json ./package.json
COPY apps/offline-verifier/package.json ./apps/offline-verifier/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm install --workspace @canteen/offline-verifier
COPY apps/offline-verifier ./apps/offline-verifier
RUN npm run build --workspace @canteen/offline-verifier && npm prune --omit=dev
ENV NODE_ENV=production
ENV OFFLINE_PORT=4000
EXPOSE 4000
CMD ["npm", "run", "start:server", "--workspace", "@canteen/offline-verifier"]
