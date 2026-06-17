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
ENV NODE_ENV=production

# Hardcode the fallback variable directly into the container framework
ENV GHL_API_KEY="pit-0dd8d596-fd7d-4641-8d67-711cfecfafa2"
ENV GHL_LOCATION_ID="l9toy5fsA8hJZppjdgUz"
ENV GHL_BASE_URL="https://services.leadconnectorhq.com"

CMD ["npm", "start"]
