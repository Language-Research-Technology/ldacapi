# LDAC API

Implementation of Arocapi for Language Data Commons - A REST API built with TypeScript, Fastify, and Prisma for Node.js 24.

## Features

- **TypeScript** - Type-safe development
- **Fastify** - Fast and low overhead web framework
- **Prisma** - Next-generation ORM for database operations
- **Node.js 24** - Latest Node.js runtime
- **Best Practices** - Well-organized folder structure with separation of concerns
- **Security** - Helmet for security headers and CORS support
- **Logging** - Structured logging with Pino
- **Error Handling** - Centralized error handling middleware
- **Code Quality** - ESLint and Prettier for code consistency

## Project Structure

```
src/
├── common/                # Shared utilities and configurations
│   ├── config/           # Application configuration
│   ├── middleware/       # Custom middleware
│   ├── types/            # TypeScript type definitions
│   └── utils/            # Utility functions
├── controllers/          # Request handlers
├── services/             # Business logic layer
├── routes/               # API route definitions
└── index.ts              # Application entry point

prisma/
└── schema.prisma         # Database schema
```

## Prerequisites

- Node.js >= 24.0.0
- PostgreSQL database (or other Prisma-supported database)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/Language-Research-Technology/ldacapi.git
cd ldacapi
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
```

Edit `.env` with your configuration:
```env
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
DATABASE_URL="postgresql://user:password@localhost:5432/ldacapi?schema=public"
LOG_LEVEL=info
```

4. Generate Prisma Client:
```bash
npm run prisma:generate
```

5. Run database migrations:
```bash
npm run prisma:migrate
```

## Development

Start the development server with hot reload:
```bash
npm run dev
```

The server will start at `http://localhost:3000`

## Building

Build the project for production:
```bash
npm run build
```

## Running in Production

After building, start the production server:
```bash
npm start
```

## Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build the TypeScript code
- `npm start` - Start production server
- `npm run lint` - Lint the code
- `npm run lint:fix` - Lint and fix issues
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check code formatting
- `npm run prisma:generate` - Generate Prisma Client
- `npm run prisma:migrate` - Run database migrations
- `npm run prisma:studio` - Open Prisma Studio

## API Endpoints

### Health Check

- **GET** `/api/v1/health` - Check API health status

Response:
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "timestamp": "2024-01-01T00:00:00.000Z",
    "uptime": 123.456,
    "database": {
      "connected": true
    }
  }
}
```

### Root

- **GET** `/` - API information

Response:
```json
{
  "message": "LDAC API - Language Data Commons REST API",
  "version": "1.0.0",
  "documentation": "/api/v1/health"
}
```

## Adding New Features

### 1. Create a Service

Create a new service in `src/services/`:

```typescript
// src/services/example.service.ts
export class ExampleService {
  async getExample(id: string) {
    // Business logic here
    return { id, name: 'Example' };
  }
}

export const exampleService = new ExampleService();
```

### 2. Create a Controller

Create a controller in `src/controllers/`:

```typescript
// src/controllers/example.controller.ts
import { FastifyReply, FastifyRequest } from 'fastify';
import { exampleService } from '../services';
import { ApiResponse } from '../common/types';

export class ExampleController {
  async getExample(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const { id } = request.params;
    const data = await exampleService.getExample(id);
    const response: ApiResponse = { success: true, data };
    reply.send(response);
  }
}

export const exampleController = new ExampleController();
```

### 3. Create Routes

Create routes in `src/routes/`:

```typescript
// src/routes/example.routes.ts
import { FastifyInstance } from 'fastify';
import { exampleController } from '../controllers';

export async function exampleRoutes(fastify: FastifyInstance) {
  fastify.get('/:id', exampleController.getExample.bind(exampleController));
}
```

### 4. Register Routes

Update `src/routes/index.ts`:

```typescript
import { exampleRoutes } from './example.routes';

export async function registerRoutes(fastify: FastifyInstance) {
  await fastify.register(healthRoutes, { prefix: '/api/v1' });
  await fastify.register(exampleRoutes, { prefix: '/api/v1/examples' });
}
```

## License

Apache-2.0
