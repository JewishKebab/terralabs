data "azurerm_resource_group" "terralabs-rg" {
  name = "SharedServices-TerraLabs-RG"
}

data "azurerm_virtual_network" "terralabs-vnet" {
  resource_group_name = data.azurerm_resource_group.terralabs-rg.name
  name = "SharedServices-TerraLabs-VNet"
}

data "azurerm_subnet" "terralabs-snet" {
  resource_group_name = data.azurerm_resource_group.terralabs-rg.name
  virtual_network_name = data.azurerm_virtual_network.terralabs-vnet.name
  name = "SharedServices-TerraLabs-SNet"
}

module "VMs" {
  source = "../../Modules/WindowsSnapshot"
  vm_count = var.vm_count
  subnet_id = data.azurerm_subnet.terralabs-snet.id
  vm_size = var.vm_size
  resource_group_name = data.azurerm_resource_group.terralabs-rg.name
  vm_name = var.server_vm_name
  data_disks = var.data_disks
  os_snapshot_id = var.snapshot_id
}
