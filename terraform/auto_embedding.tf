# ── Atlas Vector Search Auto-Embedding ────────────────────────────────────────
#
# Auto-Embedding is configured directly in the vector search index definitions
# in vector_search.tf using the "autoEmbed" field type (voyage-4 model).
#
# Each index field specifies:
#   type     = "autoEmbed"
#   modality = "text"
#   path     = "<source text field>"   e.g. "pageContent" or "value.content"
#   model    = "voyage-4"
#
# Atlas reads the source text field on every insert/update and generates the
# embedding server-side via the MongoDB AI Gateway — no Voyage AI API key or
# client-side embedding code required.
#
# This file is intentionally empty; it previously contained a null_resource
# workaround that called the Atlas Admin API separately. That is no longer
# needed now that the mongodbatlas provider supports "autoEmbed" fields natively
# in the mongodbatlas_search_index resource.
# ──────────────────────────────────────────────────────────────────────────────

# (file intentionally empty — auto-embedding is configured in vector_search.tf)

