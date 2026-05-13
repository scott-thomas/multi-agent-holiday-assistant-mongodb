terraform {
  required_version = ">= 1.6"

  required_providers {
    mongodbatlas = {
      source  = "mongodb/mongodbatlas"
      version = "~> 1.21"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}

# ── Atlas provider ─────────────────────────────────────────────────────────────
# Credentials are passed via TF_VAR_atlas_public_key / TF_VAR_atlas_private_key
# or via the MONGODB_ATLAS_PUBLIC_KEY / MONGODB_ATLAS_PRIVATE_KEY env vars.
provider "mongodbatlas" {
  public_key  = var.atlas_public_key
  private_key = var.atlas_private_key
}

# ── Shared locals ──────────────────────────────────────────────────────────────
locals {
  # Strip the "mongodb+srv://" prefix so we can inject credentials ourselves.
  cluster_host = replace(
    mongodbatlas_advanced_cluster.main.connection_strings[0].standard_srv,
    "mongodb+srv://",
    ""
  )

  # Full connection string used by the seed script and exposed as an output.
  # NOTE: if db_password contains URL-special characters (@ : / ? # [ ] !)
  #       they must be percent-encoded before being set in the variable.
  mongodb_uri = "mongodb+srv://${var.db_username}:${var.db_password}@${local.cluster_host}"
}
