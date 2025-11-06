data "azurerm_resource_group" "terralabs-rg" {
  name = "Projects-TerraLabs-RG"
  provider = azurerm.Projects
}

data "azurerm_virtual_network" "terralabs-vnet" {
  resource_group_name = data.azurerm_resource_group.terralabs-rg.name
  name = "Projects-TerraLabs-VNet"
  provider = azurerm.Projects
}

data "azurerm_subnet" "terralabs-snet" {
  resource_group_name = data.azurerm_resource_group.terralabs-rg.name
  virtual_network_name = data.azurerm_virtual_network.terralabs-vnet.name
  name = "Projects-TerraLabs-SNet"
  provider = azurerm.Projects
}

module "VMs" {
  source = "../../../Modules/WindowsSnapshot"
  vm_count = var.vm_count
  subnet_id = data.azurerm_subnet.terralabs-snet.id
  vm_size = var.vm_size
  resource_group_name = data.azurerm_resource_group.terralabs-rg.name
  vm_name = var.vm_name
  data_disks = var.data_disks
  os_snapshot_id = var.os_snapshot_id
  providers = {
  azurerm = azurerm.Projects
  }
  computer_name = ""
  extra_tags = {
    LabId      = var.lab_id
    CreatedAt  = var.created_at
    ExpiresAt  = var.expires_at
    LabCourse  = var.course   
  }
}
