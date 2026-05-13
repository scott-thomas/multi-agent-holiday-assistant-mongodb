# ── Database Seeding ───────────────────────────────────────────────────────────
#
# Runs `npm run seed` from the application root after:
#   • The cluster is healthy
#   • The database user exists
#   • Network access is open
#
# NOTE: Seeding runs BEFORE vector search indexes are created.
# Atlas autoEmbed indexes require the target collections to already exist,
# so the seed script must populate them first.
#
# Set seed_database = false to skip seeding (e.g. when the data already exists).
# ──────────────────────────────────────────────────────────────────────────────

locals {
  # Use the explicit override if provided, otherwise assume terraform/ lives
  # one level below the application root.
  app_root = var.app_root_path != "" ? var.app_root_path : "${path.module}/.."
}

resource "null_resource" "seed_database" {
  count = var.seed_database ? 1 : 0

  # Re-seed if the cluster changes (new cluster = empty database).
  triggers = {
    cluster_id = mongodbatlas_advanced_cluster.main.cluster_id
  }

  depends_on = [
    mongodbatlas_database_user.app,
    mongodbatlas_project_ip_access_list.allowed,
  ]

  provisioner "local-exec" {
    working_dir = local.app_root

    environment = {
      MONGODB_URI    = local.mongodb_uri
      OPENAI_API_KEY = var.openai_api_key
    }

    command = <<-BASH
      set -euo pipefail

      echo "Installing Node.js dependencies (if needed)..."
      npm install --prefer-offline 2>&1 | tail -5

      echo "Seeding holiday_db and agent_memory..."
      npm run seed

      echo "Seeding complete."
    BASH

    interpreter = ["bash", "-c"]
  }
}
