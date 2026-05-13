# ── Database User ──────────────────────────────────────────────────────────────
#
# Creates a SCRAM-SHA-256 user scoped to this cluster with readWrite on
# the two application databases:
#   • holiday_db    – hotels, bookings, travel policies
#   • agent_memory  – long-term memory (MongoDBStore)
# ──────────────────────────────────────────────────────────────────────────────

resource "mongodbatlas_database_user" "app" {
  project_id         = var.atlas_project_id
  username           = var.db_username
  password           = var.db_password
  auth_database_name = "admin" # SCRAM authentication database

  roles {
    role_name     = "readWrite"
    database_name = "holiday_db"
  }

  roles {
    role_name     = "readWrite"
    database_name = "agent_memory"
  }

  # Restrict the user to this specific cluster (defence-in-depth)
  scopes {
    name = mongodbatlas_advanced_cluster.main.name
    type = "CLUSTER"
  }

  labels {
    key   = "purpose"
    value = "application"
  }

  labels {
    key   = "managed-by"
    value = "terraform"
  }
}

# ── Network Access (IP Access List) ───────────────────────────────────────────
#
# Defaults to 0.0.0.0/0 (all IPs) for development convenience.
# In production, restrict this to your application server CIDRs or use
# VPC/Private Link peering instead.
# ──────────────────────────────────────────────────────────────────────────────

resource "mongodbatlas_project_ip_access_list" "allowed" {
  for_each = toset(var.allowed_cidrs)

  project_id = var.atlas_project_id
  cidr_block = each.value
    comment    = "Managed by Terraform – holiday-ai-assistant"
}
