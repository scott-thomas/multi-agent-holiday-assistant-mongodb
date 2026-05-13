output "cluster_id" {
  description = "Atlas cluster ID"
  value       = mongodbatlas_advanced_cluster.main.cluster_id
}

output "cluster_state" {
  description = "Current state of the Atlas cluster"
  value       = mongodbatlas_advanced_cluster.main.state_name
}

output "mongodb_uri" {
  description = "Full MongoDB connection string (credentials embedded)"
  value       = local.mongodb_uri
  sensitive   = true
}

output "mongodb_uri_no_creds" {
  description = "Connection string without credentials (safe to log)"
  value       = mongodbatlas_advanced_cluster.main.connection_strings[0].standard_srv
}

output "db_username" {
  description = "Atlas database user created for the application"
  value       = mongodbatlas_database_user.app.username
}

output "vector_search_index_ids" {
  description = "IDs of all three Vector Search indexes"
  value = {
    hotels_vector_index = mongodbatlas_search_index.fares_vector.index_id
    policy_vector_index = mongodbatlas_search_index.policies_vector.index_id
    memory_vector_index = mongodbatlas_search_index.memory_vector.index_id
  }
}

output "env_file_contents" {
  description = "Ready-to-paste .env contents for the application"
  sensitive   = true
  value       = <<-EOT
    OPENAI_API_KEY=${var.openai_api_key}
    MONGODB_URI=${local.mongodb_uri}
    PORT=3000
  EOT
}
