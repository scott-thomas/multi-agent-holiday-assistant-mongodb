# ── Atlas Cluster ──────────────────────────────────────────────────────────────
#
# Uses the newer mongodbatlas_advanced_cluster resource which supports
# all current Atlas cluster configurations including multi-region and
# search node topology.
#
# M10 is the MINIMUM tier for Atlas Vector Search on a dedicated cluster.
# Upgrade to M30+ if you need dedicated Search Nodes (mongodbatlas_search_deployment).
# ──────────────────────────────────────────────────────────────────────────────

resource "mongodbatlas_advanced_cluster" "main" {
  project_id   = var.atlas_project_id
  name         = var.cluster_name
  cluster_type = "REPLICASET"

  mongo_db_major_version = var.mongo_db_major_version

  # Continuous cloud backup (point-in-time restore)
  backup_enabled = var.cloud_backup

  replication_specs {
    region_configs {
      provider_name = var.cloud_provider
      region_name   = var.region
      priority      = 7

      electable_specs {
        instance_size = var.cluster_tier
        node_count    = 3 # standard replica set: 1 primary + 2 secondaries
        disk_size_gb  = var.disk_size_gb
      }

      # Compute auto-scaling is REQUIRED for Atlas auto-embedding (autoEmbed).
      # Without this, creating an autoEmbed vector search index returns
      # AUTO_EMBEDDING_AUTOSCALING_REQUIRED.
      auto_scaling {
        compute_enabled            = true
        disk_gb_enabled            = true
        compute_scale_down_enabled = true
        compute_min_instance_size  = var.cluster_tier
        compute_max_instance_size  = "M40"
      }
    }
  }

  # Enable auto-scaling for disk (storage grows automatically with data)
  advanced_configuration {
    javascript_enabled           = false
    minimum_enabled_tls_protocol = "TLS1_2"
  }

  labels {
    key   = "environment"
    value = "production"
  }

  labels {
    key   = "project"
    value = "flight-ai-assistant"
  }

  labels {
    key   = "managed-by"
    value = "terraform"
  }
}
