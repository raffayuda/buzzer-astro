FROM node:20-alpine AS runner

WORKDIR /app

# Set environment
ENV NODE_ENV=production
ENV PORT=3001

# Copy dependency definition
COPY package.json ./

# Install only production dependencies
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

# Copy application assets & code
COPY server.js ./
COPY public ./public
COPY media ./media

# Change ownership to node user
RUN chown -R node:node /app

# Run as non-root user for security
USER node

# Expose port (default 3001)
EXPOSE 3001

# Start buzzer server
CMD ["node", "server.js"]
