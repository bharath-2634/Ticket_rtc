FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM dependencies AS backend-build
COPY . .
RUN npm run build:backend

FROM node:22-alpine AS backend
WORKDIR /app
ENV NODE_ENV=production
COPY --from=backend-build /app /app
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]

FROM dependencies AS dashboard-dev
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "-w", "@ticket-rpc/dashboard"]

FROM dependencies AS dashboard-build
COPY . .
RUN npm run build -w @ticket-rpc/dashboard

FROM nginx:alpine AS dashboard-production
COPY --from=dashboard-build /app/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 80