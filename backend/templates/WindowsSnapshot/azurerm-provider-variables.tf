variable "Hub_Subscription_ID" {
  type        = string
  description = "Azure subscription ID for Hub subscription."
  default     = "80d0a5f6-1471-4cca-9a40-5ea81b9f7c19"
}

variable "Projects_Subscription_ID" {
  type        = string
  description = "Azure subscription ID for Projects subscription."
  default     = "89641046-9c08-41ad-954a-7ff2f2d626f7"
}

variable "SharedServices_Subscription_ID" {
  type        = string
  description = "Azure subscription ID for Shared Services subscription."
  default     = "94893b9b-e69d-4648-823c-a72a0b9ede71"
}

variable "storage_account_id" {
  type    = string
  default = "/subscriptions/94893b9b-e69d-4648-823c-a72a0b9ede71/resourceGroups/SharedServices-Bsmch-StorageAccounts-RG/providers/Microsoft.Storage/storageAccounts/bsmchterraformbackendsa"
}

variable "storage_account_resource_group" {
  type    = string
  default = "SharedServices-Bsmch-StorageAccounts-RG"
}