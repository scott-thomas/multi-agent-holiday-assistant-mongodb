# ── Atlas API credentials ──────────────────────────────────────────────────────
variable "atlas_public_key" {
  description = "MongoDB Atlas API public key (Org or Project level)"
  type        = string
  sensitive   = true
}

variable "atlas_private_key" {
  description = "MongoDB Atlas API private key"
  type        = string
  sensitive   = true
}

variable "atlas_project_id" {
  description = "MongoDB Atlas project ID where the cluster will be deployed"
  type        = string
}

# ── Cluster ────────────────────────────────────────────────────────────────────
variable "cluster_name" {
  description = "Name for the Atlas cluster"
  type        = string
  default     = "holiday-ai-assistant"
}

variable "cloud_provider" {
  description = "Cloud provider for the cluster: AWS | GCP | AZURE"
  type        = string
  default     = "AWS"
}

variable "region" {
  description = "Cloud-provider region (AWS: EU_WEST_1, GCP: EUROPE_WEST_2, AZURE: UK_SOUTH)"
  type        = string
  default     = "EU_WEST_1" # AWS Ireland – closest AWS region to London for .local London context
}

variable "cluster_tier" {
  description = "Atlas instance size. M10 is the minimum tier that supports Atlas Vector Search."
  type        = string
  default     = "M10"
}

variable "mongo_db_major_version" {
  description = "MongoDB major version"
  type        = string
  default     = "8.0"
}

variable "disk_size_gb" {
  description = "Storage size in GB for the cluster (minimum 10 for M10)"
  type        = number
  default     = 10
}

variable "cloud_backup" {
  description = "Enable continuous cloud backup"
  type        = bool
  default     = true
}

# ── Database user ──────────────────────────────────────────────────────────────
variable "db_username" {
  description = "Username for the Atlas database user"
  type        = string
  default     = "holiday-app-user"
}

variable "db_password" {
  description = <<-EOT
    Password for the Atlas database user.
    Avoid URL-special characters (@ : / ? # [ ] !) or percent-encode them
    before setting this variable, as the password is embedded in the URI.
  EOT
  type      = string
  sensitive = true
}

# ── Network access ─────────────────────────────────────────────────────────────
variable "allowed_cidrs" {
  description = <<-EOT
    List of CIDR blocks permitted to connect to the cluster.
    Restrict this in production — "0.0.0.0/0" allows all IPs.
  EOT
  type    = list(string)
  default = ["0.0.0.0/0"]
}

# ── Application secrets (forwarded to the seed script) ────────────────────────
variable "openai_api_key" {
  description = "OpenAI API key (used by the seed script to generate synthetic hotel and travel policy data)"
  type        = string
  sensitive   = true
}

# ── Seeding ────────────────────────────────────────────────────────────────────
variable "seed_database" {
  description = "Run 'npm run seed' after the cluster and user are ready"
  type        = bool
  default     = true
}

variable "app_root_path" {
  description = <<-EOT
    Absolute path to the application root (the directory containing package.json).
    Defaults to the parent of the terraform/ directory.
  EOT
  type    = string
  default = "" # resolved to path.module/.. at plan time
}
