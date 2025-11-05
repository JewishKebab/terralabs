terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">3.0.0"
    }
  }
}

provider "azurerm" {
  features {
    resource_group {
      prevent_deletion_if_contains_resources = false
    }
  }
}

provider "azurerm" {
  alias           = "Hub"
  subscription_id = var.Hub_Subscription_ID
  features {
    resource_group {
      prevent_deletion_if_contains_resources = false
    }
  }
}

provider "azurerm" {
  alias           = "Projects"
  subscription_id = var.Projects_Subscription_ID
  features {
    resource_group {
      prevent_deletion_if_contains_resources = false
    }
  }
}