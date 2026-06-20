# Stage 1: Build the TypeScript code
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./

# Install ALL packages (including typescript and types) so compilation works
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Create a clean, production-only runner image
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./

# Copy the compiled files from the builder stage
COPY --from=builder /app/dist ./dist

# Install ONLY production dependencies to keep the image lightweight
RUN npm ci --only=production

EXPOSE 8000

# Pull the keys dynamically from your Railway Dashboard at boot time
ARG GHL_API_KEY
ARG GHL_LOCATION_ID
ARG GHL_BASE_URL
ARG NODE_ENV
ARG PORT

ENV GHL_API_KEY=$GHL_API_KEY
ENV GHL_BASE_URL=$GHL_BASE_URL
ENV GHL_LOCATION_ID=$GHL_LOCATION_ID
ENV NODE_ENV=$NODE_ENV
ENV PORT=$PORT

CMD ["npm", "start"]
