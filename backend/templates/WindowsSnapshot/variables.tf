##############################
# VM Module Input Variables
##############################

variable "vm_count" {
  description = "Number of virtual machines to create."
  type        = number
}



variable "vm_size" {
  description = "The Azure VM size."
  type        = string
}

variable "vm_name" {
  description = "The Azure VM Name."
}

variable "os_snapshot_id" {
  description = "The resource ID of the snapshot to use for OS disk creation. Leave empty if not using a snapshot."
  type        = string
  default     = ""
}

variable "data_disks" {
  description = "Optional list of additional data disks to attach to each VM."
  type = list(object({
    name         = string
    lun          = number
    caching      = string
    disk_size_gb = number
  }))
  default = []
}
