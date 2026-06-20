# Stage 1: Build the TypeScript code
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Create a clean, production-only runner image
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
COPY --from=builder /app/dist ./dist
RUN npm ci --only=production
EXPOSE 8000
CMD ["npm", "run", "start:http"]
