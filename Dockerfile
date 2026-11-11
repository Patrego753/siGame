# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json ./
COPY shared ./shared
COPY server ./server
COPY client ./client

RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/client/dist ./client/dist

ENV PORT=5174
EXPOSE 5174

CMD ["npm", "start"]
