FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY public ./public
COPY lib ./lib
ENV NODE_ENV=production PORT=10000
USER node
EXPOSE 10000
CMD ["node", "server/index.mjs"]
