import type { FastifyPluginAsync } from "fastify";

import { GenericVectorRequestSchema, SearchVectorsRequestSchema } from "../contracts/vector-library.js";
import { ok } from "../contracts/common.js";
import { NotMigratedError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";

interface CollectionParams {
  collectionName: string;
}

interface DocumentParams {
  collectionName: string;
  documentId: string;
}

export const registerVectorRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/collections", async () => ({
    success: true,
    data: options.container.vectorLibrary.listCollections(),
    count: 0,
  }));

  app.delete<{ Params: CollectionParams }>("/collections/:collectionName", async () => {
    throw new NotMigratedError("Vector collection deletion");
  });

  app.post("/search", async (request) => {
    SearchVectorsRequestSchema.parse(request.body);
    throw new NotMigratedError("Vector search");
  });

  app.post("/index", async (request) => {
    GenericVectorRequestSchema.parse(request.body ?? {});
    throw new NotMigratedError("Vector document indexing");
  });

  app.delete<{ Params: DocumentParams }>("/documents/:collectionName/:documentId", async () => {
    throw new NotMigratedError("Vector document deletion");
  });

  app.get<{ Params: CollectionParams }>("/documents/:collectionName", async (request) => ({
    success: true,
    data: options.container.vectorLibrary.listDocuments(request.params.collectionName),
  }));

  app.get("/health", async () => ok(options.container.vectorLibrary.vectorHealth()));
};
