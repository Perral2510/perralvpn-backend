FROM node:20-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p data
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/app.sqlite
EXPOSE 3000 3001
CMD ["node", "backend/server.js"]
