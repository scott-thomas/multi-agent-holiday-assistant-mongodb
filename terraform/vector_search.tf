# ── Atlas Vector Search Indexes ────────────────────────────────────────────────
#
# Three autoEmbed vector search indexes. Atlas reads the configured `path`
# field from each inserted document and generates embeddings server-side
# using voyage-4 via the MongoDB AI Gateway — no Voyage AI API key needed.
#
#   DB / Collection                        Index name            Embed field
#   ─────────────────────────────────────  ────────────────────  ──────────────
#   holiday_db   / hotels                  hotels_vector_index   pageContent
#   holiday_db   / travel_policies         policy_vector_index   pageContent
#   agent_memory / long_term_memory        memory_vector_index   value.content
# ──────────────────────────────────────────────────────────────────────────────

# ── 1. hotels ─────────────────────────────────────────────────────────────────
resource "mongodbatlas_search_index" "fares_vector" {
  project_id      = var.atlas_project_id
  cluster_name    = mongodbatlas_advanced_cluster.main.name

  name            = "hotels_vector_index"
  database        = "holiday_db"
  collection_name = "hotels"
  type            = "vectorSearch"

  fields = jsonencode([
    # autoEmbed: Atlas reads `pageContent` and generates the vector server-side.
    {
      type     = "autoEmbed"
      modality = "text"
      path     = "pageContent"
      model    = "voyage-4"
    },
    # Pre-filter fields for efficient $vectorSearch with filter clause.
    { type = "filter", path = "metadata.city" },
    { type = "filter", path = "metadata.country" },
    { type = "filter", path = "metadata.star_rating" },
    { type = "filter", path = "metadata.property_type" },
    { type = "filter", path = "metadata.room_types.currency" }
  ])

  depends_on = [
    null_resource.seed_database,
    mongodbatlas_advanced_cluster.main,
  ]
}

# ── 2. travel_policies ───────────────────────────────────────────────────────
resource "mongodbatlas_search_index" "policies_vector" {
  project_id      = var.atlas_project_id
  cluster_name    = mongodbatlas_advanced_cluster.main.name

  name            = "policy_vector_index"
  database        = "holiday_db"
  collection_name = "travel_policies"
  type            = "vectorSearch"

  fields = jsonencode([
    {
      type     = "autoEmbed"
      modality = "text"
      path     = "pageContent"
      model    = "voyage-4"
    },
    { type = "filter", path = "metadata.category" },
    { type = "filter", path = "metadata.version" }
  ])

  depends_on = [
    null_resource.seed_database,
    mongodbatlas_advanced_cluster.main,
  ]
}

# ── 3. long_term_memory ────────────────────────────────────────────────────────
#
# long_term_memory is normally created by MongoDBStore.start() at app runtime.
# We create it explicitly here so the autoEmbed index can be provisioned by
# Terraform before the app has ever started.
# ──────────────────────────────────────────────────────────────────────────────
resource "null_resource" "ensure_memory_collection" {
  triggers = {
    cluster_id = mongodbatlas_advanced_cluster.main.cluster_id
  }

  depends_on = [
    mongodbatlas_database_user.app,
    mongodbatlas_project_ip_access_list.allowed,
    null_resource.seed_database,
  ]

  provisioner "local-exec" {
    command = <<-BASH
      set -euo pipefail
      echo "Ensuring agent_memory.long_term_memory collection exists..."
      mongosh "${local.mongodb_uri}" --quiet --eval '
        const db = db.getSiblingDB("agent_memory");
        if (!db.getCollectionNames().includes("long_term_memory")) {
          db.createCollection("long_term_memory");
          print("Created long_term_memory collection.");
        } else {
          print("long_term_memory already exists.");
        }
      '
    BASH
    interpreter = ["bash", "-c"]
  }
}

resource "mongodbatlas_search_index" "memory_vector" {
  project_id      = var.atlas_project_id
  cluster_name    = mongodbatlas_advanced_cluster.main.name

  name            = "memory_vector_index"
  database        = "agent_memory"
  collection_name = "long_term_memory"
  type            = "vectorSearch"

  fields = jsonencode([
    # putUserMemory writes a `content` string into every stored value object;
    # MongoDBStore persists it as `value.content` in the collection document.
    {
      type     = "autoEmbed"
      modality = "text"
      path     = "value.content"
      model    = "voyage-4"
    },
    # Per-user namespace isolation at the index filter level.
    # MongoDBStore writes a `namespacePath` field on every document and filters
    # $vectorSearch by { namespacePath: "<userId>/memories" }, so the pre-filter
    # field MUST be named `namespacePath` (not `namespace`/`prefix`).
    { type = "filter", path = "namespacePath" }
  ])

  depends_on = [
    null_resource.ensure_memory_collection,
    mongodbatlas_advanced_cluster.main,
  ]
}

# ── TTL indexes ────────────────────────────────────────────────────────────────
#
# The MongoDBStore (long_term_memory) manages its own TTL index via
# store.start() on startup (90-day TTL, configured in memory/store.ts).
#
# The MongoDBSaver (checkpointer) does NOT have built-in TTL management,
# so we add TTL indexes here for both checkpoint collections to prevent
# unbounded growth.  LangGraph writes a `ts` Date field on every checkpoint;
# we expire documents that haven't been updated in 30 days.
# ──────────────────────────────────────────────────────────────────────────────

resource "mongodbatlas_custom_db_role" "checkpointer_ttl_placeholder" {
  # Atlas does not expose a native "create index" Terraform resource for
  # non-Search indexes.  The TTL indexes below are created by the seed
  # null_resource via mongosh, which is included in the Atlas cluster image.
  project_id = var.atlas_project_id
  role_name  = "placeholder-never-used"
  count      = 0 # disabled; kept as documentation anchor
}

resource "null_resource" "ttl_indexes" {
  triggers = {
    cluster_id = mongodbatlas_advanced_cluster.main.cluster_id
  }

  depends_on = [
    mongodbatlas_database_user.app,
    mongodbatlas_project_ip_access_list.allowed,
    mongodbatlas_search_index.fares_vector,
    mongodbatlas_search_index.policies_vector,
    mongodbatlas_search_index.memory_vector,
  ]

  provisioner "local-exec" {
    # Creates TTL indexes on the two checkpoint collections so stale
    # short-term memory (conversation history) is automatically pruned.
    # 30 days = 2592000 seconds.  The `ts` field is a BSON Date set by
    # MongoDBSaver on every write.
    command = <<-BASH
      set -euo pipefail

      MONGODB_URI="${local.mongodb_uri}"

      echo "Creating TTL indexes on checkpoint collections..."

      mongosh "$MONGODB_URI" --quiet --eval '
        const db30 = 2592000; // 30 days in seconds

        // checkpoints collection
        db.getSiblingDB("agent_memory").checkpoints.createIndex(
          { ts: 1 },
          { expireAfterSeconds: db30, name: "checkpoints_ttl", background: true }
        );

        // checkpoint_writes collection
        db.getSiblingDB("agent_memory").checkpoint_writes.createIndex(
          { ts: 1 },
          { expireAfterSeconds: db30, name: "checkpoint_writes_ttl", background: true }
        );

        print("TTL indexes created (or already exist).");
      '
    BASH

    interpreter = ["bash", "-c"]
  }
}
