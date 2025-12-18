<template>
  <div class="search-container">
    <el-row :gutter="20">
      <el-col :span="24">
        <el-card class="search-card">
          <template #header>
            <div class="card-header">
              <h3>知识图谱查询</h3>
              <el-radio-group v-model="searchForm.queryMode" @change="handleQueryModeChange">
                <el-radio-button value="entity">基础实体</el-radio-button>
                <el-radio-button value="state">状态节点</el-radio-button>
              </el-radio-group>
            </div>
          </template>
          <div class="search-form">
            <el-form :model="searchForm" label-width="100px">
              <!-- 基础实体查询 -->
              <div v-if="searchForm.queryMode === 'entity'">
                <el-row :gutter="20">
                  <el-col :span="8">
                    <el-form-item label="实体类型">
                      <el-select v-model="searchForm.category" placeholder="选择实体类型" style="width: 100%">
                        <el-option label="全部" value="" />
                        <el-option label="地点" value="地点" />
                        <el-option label="设施" value="设施" />
                        <el-option label="事件" value="事件" />
                      </el-select>
                    </el-form-item>
                  </el-col>
                  <el-col :span="8">
                    <el-form-item label="关键词">
                      <el-input v-model="searchForm.keyword" placeholder="实体名称、ID或描述" clearable />
                    </el-form-item>
                  </el-col>
                  <el-col :span="8">
                    <el-form-item label="地理位置">
                      <el-cascader v-model="searchForm.location" :options="locationOptions" placeholder="选择地理位置"
                        :props="{ checkStrictly: true }" clearable style="width: 100%" />
                    </el-form-item>
                  </el-col>
                </el-row>
              </div>

              <!-- 状态节点查询 -->
              <div v-else>
                <el-row :gutter="20">
                  <el-col :span="6">
                    <el-form-item label="状态类型">
                      <el-select v-model="searchForm.stateType" placeholder="选择状态类型" style="width: 100%">
                        <el-option label="全部" value="" />
                        <el-option label="事件状态" value="event" />
                        <el-option label="地点状态" value="location" />
                        <el-option label="设施状态" value="facility" />
                        <el-option label="联合状态" value="joint" />
                      </el-select>
                    </el-form-item>
                  </el-col>
                  <el-col :span="6">
                    <el-form-item label="关键词">
                      <el-input v-model="searchForm.keyword" placeholder="实体名称或ID" clearable />
                    </el-form-item>
                  </el-col>
                  <el-col :span="6">
                    <el-form-item label="属性筛选">
                      <el-select v-model="searchForm.attributeType" placeholder="选择属性类型" clearable style="width: 100%">
                        <el-option label="全部" value="" />
                        <el-option label="降雨量" value="降雨量" />
                        <el-option label="受灾人口" value="受灾人口" />
                        <el-option label="经济损失" value="经济损失" />
                        <el-option label="水位变化" value="水位变化" />
                        <el-option label="转移人口" value="转移人口" />
                      </el-select>
                    </el-form-item>
                  </el-col>
                  <el-col :span="6">
                    <el-form-item label="地理位置">
                      <el-cascader v-model="searchForm.location" :options="locationOptions" placeholder="选择地理位置"
                        :props="{ checkStrictly: true }" clearable style="width: 100%" />
                    </el-form-item>
                  </el-col>
                </el-row>
                <el-row :gutter="20">
                  <el-col :span="12">
                    <el-form-item label="时间范围">
                      <el-date-picker v-model="searchForm.timeRange" type="daterange" range-separator="至"
                        start-placeholder="开始日期" end-placeholder="结束日期" style="width: 100%" />
                    </el-form-item>
                  </el-col>
                  <el-col :span="12">
                    <el-form-item label="关系类型">
                      <el-select v-model="searchForm.relationType" placeholder="筛选有此关系的状态" clearable style="width: 100%">
                        <el-option label="全部" value="" />
                        <el-option label="导致" value="导致" />
                        <el-option label="间接导致" value="间接导致" />
                        <el-option label="隐含导致" value="隐含导致" />
                        <el-option label="触发" value="触发" />
                      </el-select>
                    </el-form-item>
                  </el-col>
                </el-row>
              </div>

              <!-- 共同选项 -->
              <el-row :gutter="20">
                <el-col :span="12">
                  <el-form-item label="文档来源">
                    <el-select v-model="searchForm.documentSource" placeholder="选择文档来源" clearable style="width: 100%">
                      <el-option label="全部" value="" />
                      <el-option v-for="doc in documentSources" :key="doc" :label="doc" :value="doc" />
                    </el-select>
                  </el-form-item>
                </el-col>
                <el-col :span="12">
                  <el-form-item label="高级查询">
                    <el-switch v-model="searchForm.advancedOptions" active-text="启用Cypher" inactive-text="禁用" />
                  </el-form-item>
                </el-col>
              </el-row>
              <el-row v-if="searchForm.advancedOptions">
                <el-col :span="24">
                  <el-form-item label="Cypher查询">
                    <el-input v-model="searchForm.cypherQuery" type="textarea" :rows="3" 
                      placeholder="高级用户可输入自定义Cypher查询语句" />
                  </el-form-item>
                </el-col>
              </el-row>
              <el-form-item>
                <el-button type="primary" @click="searchEntities" :loading="loading">
                  <el-icon><Search /></el-icon> 查询
                </el-button>
                <el-button @click="resetForm">
                  <el-icon><RefreshLeft /></el-icon> 重置
                </el-button>
                <el-button type="success" @click="exportResults" :disabled="!allSearchResults.length">
                  <el-icon><Download /></el-icon> 导出结果
                </el-button>
                <el-button type="info" @click="showQueryHelp">
                  <el-icon><QuestionFilled /></el-icon> 查询帮助
                </el-button>
              </el-form-item>
            </el-form>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" style="margin-top: 20px;">
      <el-col :span="24">
        <el-card class="results-card" v-loading="loading">
          <template #header>
            <div class="card-header">
              <h3>查询结果</h3>
              <el-space>
                <span>共 {{ allSearchResults.length }} 条结果</span>
                <el-tag v-if="searchForm.queryMode === 'entity'" type="info">基础实体</el-tag>
                <el-tag v-else type="success">状态节点</el-tag>
              </el-space>
            </div>
          </template>
          <div class="search-results">
            <el-tabs v-model="activeTab">
              <el-tab-pane label="表格视图" name="table">
                <el-table :data="searchResults" style="width: 100%" border @row-click="selectEntity" 
                  :row-class-name="getRowClassName">
                  <el-table-column prop="id" label="ID" width="220" show-overflow-tooltip />
                  <el-table-column prop="name" label="名称" width="150" />
                  <el-table-column prop="category" label="类型" width="120">
                    <template #default="scope">
                      <el-tag v-if="searchForm.queryMode === 'entity'" :type="getEntityTypeTag(scope.row.category)">
                        {{ scope.row.category }}
                      </el-tag>
                      <el-tag v-else :type="getStateTypeTag(scope.row)">
                        {{ getStateTypeName(scope.row) }}
                      </el-tag>
                    </template>
                  </el-table-column>
                  <el-table-column v-if="searchForm.queryMode === 'state'" prop="time" label="时间" width="180" />
                  <el-table-column prop="source" label="来源" width="180" show-overflow-tooltip />
                  <el-table-column label="关键信息" min-width="300">
                    <template #default="scope">
                      <div v-if="searchForm.queryMode === 'entity'">
                        <div v-for="(value, key) in getKeyProperties(scope.row.properties)" :key="key" class="property-item">
                          <el-tag size="small" class="property-key">{{ key }}</el-tag>
                          <span class="property-value">{{ value }}</span>
                        </div>
                      </div>
                      <div v-else class="state-info">
                        <div class="entity-ids-section" v-if="scope.row.entity_ids && scope.row.entity_ids.length">
                          <el-text size="small" type="info">关联实体:</el-text>
                          <el-tag v-for="eid in scope.row.entity_ids.slice(0, 2)" :key="eid" 
                            size="small" type="info" class="entity-id-tag">
                            {{ getShortEntityName(eid) }}
                          </el-tag>
                          <el-tag v-if="scope.row.entity_ids.length > 2" size="small" type="info">
                            +{{ scope.row.entity_ids.length - 2 }}
                          </el-tag>
                        </div>
                        <div class="attributes-section" v-if="scope.row.attributes && scope.row.attributes.length">
                          <el-text size="small" type="success">属性:</el-text>
                          <el-tag v-for="(attr, idx) in scope.row.attributes.slice(0, 3)" :key="idx" 
                            size="small" type="success">
                            {{ attr.type }}: {{ getShortValue(attr.value) }}
                          </el-tag>
                          <el-button v-if="scope.row.attributes.length > 3" 
                            size="small" type="text" @click.stop="viewStateAttributes(scope.row)">
                            +{{ scope.row.attributes.length - 3 }}个
                          </el-button>
                        </div>
                        <el-empty v-if="!scope.row.attributes || !scope.row.attributes.length" 
                          description="无属性" :image-size="40" style="padding: 10px 0;" />
                      </div>
                    </template>
                  </el-table-column>
                  <el-table-column label="操作" width="200" fixed="right">
                    <template #default="scope">
                      <el-space wrap>
                        <el-button size="small" type="primary" text @click.stop="viewDetails(scope.row)">
                          详情
                        </el-button>
                        <el-button size="small" type="success" text @click.stop="viewInGraph(scope.row)">
                          图谱
                        </el-button>
                        <el-button v-if="searchForm.queryMode === 'state'" size="small" type="warning" text 
                          @click.stop="viewCausalChain(scope.row)">
                          因果链
                        </el-button>
                      </el-space>
                    </template>
                  </el-table-column>
                </el-table>
                <div class="pagination-container">
                  <el-pagination v-model:current-page="currentPage" v-model:page-size="pageSize"
                    :page-sizes="[10, 20, 50, 100]" layout="total, sizes, prev, pager, next, jumper"
                    :total="allSearchResults.length" />
                </div>
              </el-tab-pane>
              
              <el-tab-pane label="关系视图" name="relations">
                <div class="relations-view">
                  <div v-if="selectedEntity" class="entity-relations">
                    <div class="relation-header">
                      <div class="header-left">
                        <h4>{{ selectedEntity.name || selectedEntity.id }} 的关系网络</h4>
                        <el-tag v-if="searchForm.queryMode === 'state'" size="small" type="primary">
                          {{ selectedEntity.state_type || 'State' }}
                        </el-tag>
                      </div>
                      <el-button size="small" @click="loadEntityRelations(selectedEntity.id)">
                        <el-icon><Refresh /></el-icon> 刷新
                      </el-button>
                    </div>
                    <el-divider />
                    <div v-loading="relationsLoading">
                      <div v-if="entityRelations.nodes && entityRelations.nodes.length > 0">
                        <el-descriptions :column="3" border size="small" style="margin-bottom: 20px;">
                          <el-descriptions-item label="节点总数">{{ entityRelations.nodes.length }}</el-descriptions-item>
                          <el-descriptions-item label="关系总数">{{ entityRelations.relationships.length }}</el-descriptions-item>
                          <el-descriptions-item label="关系类型">{{ getUniqueRelationTypes().length }}种</el-descriptions-item>
                        </el-descriptions>
                        
                        <!-- 关系分组展示（类似状态树） -->
                        <div class="relations-tree">
                          <!-- 空间关系 -->
                          <div v-if="getSpatialRelations().length > 0" class="relation-group">
                            <div class="group-header" @click="toggleGroup('spatial')">
                              <el-icon class="expand-icon" :class="{ 'expanded': expandedGroups.spatial }">
                                <CaretRight v-if="!expandedGroups.spatial" />
                                <CaretBottom v-else />
                              </el-icon>
                              <span class="group-title">空间关系</span>
                              <el-badge :value="getSpatialRelations().length" class="group-badge" />
                            </div>
                            <div v-show="expandedGroups.spatial" class="group-content">
                              <div v-for="(rel, index) in getSpatialRelations()" :key="`spatial-${index}`" class="relation-node">
                                <div class="node-connector spatial"></div>
                                <div class="relation-card">
                                  <div class="relation-row">
                                    <el-tag size="small" :type="getNodeTypeColor(getNodeById(rel.source))">
                                      {{ getNodeName(rel.source) }}
                                    </el-tag>
                                    <div class="relation-type spatial">
                                      <el-icon><Position /></el-icon>
                                      <span>{{ rel.type }}</span>
                                    </div>
                                    <el-tag size="small" :type="getNodeTypeColor(getNodeById(rel.target))">
                                      {{ getNodeName(rel.target) }}
                                    </el-tag>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>

                          <!-- 状态树（层级展示 nextState 和 contain） -->
                          <div v-if="stateTreeData.roots && stateTreeData.roots.length > 0" class="relation-group">
                            <div class="group-header" @click="toggleGroup('stateTree')">
                              <el-icon class="expand-icon" :class="{ 'expanded': expandedGroups.stateTree }">
                                <CaretRight v-if="!expandedGroups.stateTree" />
                                <CaretBottom v-else />
                              </el-icon>
                              <span class="group-title">状态节点列表</span>
                              <el-badge :value="stateTreeData.roots.length" class="group-badge" />
                            </div>
                            <div v-show="expandedGroups.stateTree" class="group-content state-tree-container">
                              <div v-for="rootNode in stateTreeData.roots" :key="rootNode.id" class="state-tree-root">
                                <div class="inline-state-node">
                                  <div class="state-node-item" @click="viewDetails({ id: rootNode.id, ...rootNode.properties })">
                                    <div v-if="(rootNode.children && rootNode.children.length > 0) || (rootNode.next && rootNode.next.length > 0)" 
                                         class="expand-btn" 
                                         @click.stop="toggleNodeExpand(rootNode.id)">
                                      <span class="expand-icon">{{ expandedNodes[rootNode.id] ? '−' : '+' }}</span>
                                    </div>
                                    <div v-else class="expand-placeholder"></div>
                                    
                                    <div class="state-dot" :class="rootNode.properties?.state_type"></div>
                                    
                                    <div class="state-info-box">
                                      <div class="state-label">{{ getStateNodeLabel(rootNode) }}</div>
                                      <div class="state-time-text">{{ formatStateTime(rootNode) }}</div>
                                    </div>
                                  </div>
                                  
                                  <!-- 子状态 (contain) -->
                                  <div v-if="rootNode.children && rootNode.children.length > 0 && expandedNodes[rootNode.id]" class="state-children">
                                    <div v-for="child in rootNode.children" :key="child.id" class="child-wrapper contain">
                                      <div class="branch-line contain"></div>
                                      <div class="state-node-item sub" @click="viewDetails({ id: child.id, ...child.properties })">
                                        <div class="expand-placeholder"></div>
                                        <div class="state-dot" :class="child.properties?.state_type"></div>
                                        <div class="state-info-box">
                                          <div class="state-label">{{ getStateNodeLabel(child) }}</div>
                                          <div class="state-time-text">{{ formatStateTime(child) }}</div>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                  
                                  <!-- 下一个状态 (nextState) -->
                                  <div v-if="rootNode.next && rootNode.next.length > 0 && expandedNodes[rootNode.id]" class="state-next">
                                    <div v-for="next in rootNode.next" :key="next.id" class="next-wrapper">
                                      <div class="branch-line next"></div>
                                      <div class="state-node-item sub" @click="viewDetails({ id: next.id, ...next.properties })">
                                        <div class="expand-placeholder"></div>
                                        <div class="state-dot" :class="next.properties?.state_type"></div>
                                        <div class="state-info-box">
                                          <div class="state-label">{{ getStateNodeLabel(next) }}</div>
                                          <div class="state-time-text">{{ formatStateTime(next) }}</div>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                          
                          <!-- 其他状态链关系（hasState 等） -->
                          <div v-if="getOtherStateChainRelations().length > 0" class="relation-group">
                            <div class="group-header" @click="toggleGroup('stateChain')">
                              <el-icon class="expand-icon" :class="{ 'expanded': expandedGroups.stateChain }">
                                <CaretRight v-if="!expandedGroups.stateChain" />
                                <CaretBottom v-else />
                              </el-icon>
                              <span class="group-title">其他状态关系</span>
                              <el-badge :value="getOtherStateChainRelations().length" class="group-badge" />
                            </div>
                            <div v-show="expandedGroups.stateChain" class="group-content">
                              <div v-for="(rel, index) in getOtherStateChainRelations()" :key="`chain-${index}`" class="relation-node">
                                <div class="node-connector chain" :class="rel.type"></div>
                                <div class="relation-card">
                                  <div class="relation-row">
                                    <el-tag size="small" :type="getNodeTypeColor(getNodeById(rel.source))">
                                      {{ getNodeName(rel.source) }}
                                    </el-tag>
                                    <div class="relation-type chain" :class="rel.type">
                                      <el-icon><Connection /></el-icon>
                                      <span>{{ rel.type }}</span>
                                    </div>
                                    <el-tag size="small" :type="getNodeTypeColor(getNodeById(rel.target))">
                                      {{ getNodeName(rel.target) }}
                                    </el-tag>
                                  </div>
                                  <div v-if="rel.properties && rel.properties.time" class="relation-time">
                                    <el-icon><Clock /></el-icon>
                                    <span>{{ rel.properties.time }}</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>

                          <!-- 因果关系 -->
                          <div v-if="getCausalRelations().length > 0" class="relation-group">
                            <div class="group-header" @click="toggleGroup('causal')">
                              <el-icon class="expand-icon" :class="{ 'expanded': expandedGroups.causal }">
                                <CaretRight v-if="!expandedGroups.causal" />
                                <CaretBottom v-else />
                              </el-icon>
                              <span class="group-title">因果关系</span>
                              <el-badge :value="getCausalRelations().length" class="group-badge" />
                            </div>
                            <div v-show="expandedGroups.causal" class="group-content">
                              <div v-for="(rel, index) in getCausalRelations()" :key="`causal-${index}`" class="relation-node">
                                <div class="node-connector causal" :class="rel.properties.type"></div>
                                <div class="relation-card highlight">
                                  <div class="relation-row">
                                    <el-tag size="small" :type="getNodeTypeColor(getNodeById(rel.source))">
                                      {{ getNodeName(rel.source) }}
                                    </el-tag>
                                    <div class="relation-type causal" :class="rel.properties.type">
                                      <el-icon><Notification /></el-icon>
                                      <span>{{ rel.properties.type || rel.type }}</span>
                                    </div>
                                    <el-tag size="small" :type="getNodeTypeColor(getNodeById(rel.target))">
                                      {{ getNodeName(rel.target) }}
                                    </el-tag>
                                  </div>
                                  <div v-if="rel.properties.basis" class="relation-basis">
                                    <el-text size="small" type="info">依据：{{ rel.properties.basis }}</el-text>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>

                          <!-- 属性关系 -->
                          <div v-if="getAttributeRelations().length > 0" class="relation-group">
                            <div class="group-header" @click="toggleGroup('attribute')">
                              <el-icon class="expand-icon" :class="{ 'expanded': expandedGroups.attribute }">
                                <CaretRight v-if="!expandedGroups.attribute" />
                                <CaretBottom v-else />
                              </el-icon>
                              <span class="group-title">属性值</span>
                              <el-badge :value="getAttributeRelations().length" class="group-badge" />
                            </div>
                            <div v-show="expandedGroups.attribute" class="group-content attributes">
                              <div v-for="(rel, index) in getAttributeRelations()" :key="`attr-${index}`" class="attribute-item">
                                <el-tag size="small" effect="plain">{{ rel.properties.type || '属性' }}</el-tag>
                                <span class="attribute-value">{{ getAttributeValue(rel.target) }}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div v-else class="no-relations">
                        <el-empty description="未找到相关关系" />
                      </div>
                    </div>
                  </div>
                  <div v-else class="no-selection">
                    <el-empty description="请在表格中选择一个节点以查看其关系" />
                  </div>
                </div>
              </el-tab-pane>

              <el-tab-pane v-if="searchForm.queryMode === 'state'" label="时序分析" name="temporal">
                <div class="temporal-view">
                  <el-empty v-if="!allSearchResults.length" description="暂无数据进行时序分析" />
                  <div v-else>
                    <div class="temporal-stats">
                      <el-statistic title="状态总数" :value="allSearchResults.length" />
                      <el-descriptions :column="1" border size="small" style="max-width: 300px;">
                        <el-descriptions-item label="时间跨度">{{ getTimeSpan() }}</el-descriptions-item>
                      </el-descriptions>
                      <el-statistic title="覆盖实体" :value="getUniqueEntities()" />
                    </div>
                    <el-divider />
                    <div class="temporal-chart">
                      <h4>时间线分布</h4>
                      <div class="timeline-container">
                        <el-timeline>
                          <el-timeline-item 
                            v-for="item in getTimelineData()" 
                            :key="item.id"
                            :timestamp="item.time" 
                            placement="top"
                            :type="item.type">
                            <el-card>
                              <h4>{{ item.name }}</h4>
                              <p>{{ item.description }}</p>
                            </el-card>
                          </el-timeline-item>
                        </el-timeline>
                      </div>
                    </div>
                  </div>
                </div>
              </el-tab-pane>
            </el-tabs>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 详情对话框 -->
    <el-dialog v-model="detailDialogVisible" title="节点详情" width="70%" :close-on-click-modal="false">
      <div v-if="currentDetail" v-loading="detailLoading">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="ID">{{ currentDetail.id }}</el-descriptions-item>
          <el-descriptions-item label="名称">{{ currentDetail.name }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ currentDetail.category }}</el-descriptions-item>
          <el-descriptions-item label="来源">{{ currentDetail.source }}</el-descriptions-item>
          <el-descriptions-item v-if="currentDetail.time" label="时间" :span="2">
            {{ currentDetail.time }}
          </el-descriptions-item>
        </el-descriptions>
        
        <el-divider content-position="left">
          <h4>{{ searchForm.queryMode === 'entity' ? '实体属性' : '状态属性' }}</h4>
        </el-divider>
        
        <div v-if="searchForm.queryMode === 'state' && currentDetail.entity_ids">
          <el-tag v-for="eid in currentDetail.entity_ids" :key="eid" style="margin: 5px;">
            {{ eid }}
          </el-tag>
          <el-divider />
        </div>
        
        <el-table v-if="currentDetail.properties" :data="Object.entries(currentDetail.properties)" border>
          <el-table-column prop="0" label="属性名" width="200" />
          <el-table-column prop="1" label="属性值">
            <template #default="scope">
              <span v-if="typeof scope.row[1] === 'object'">{{ JSON.stringify(scope.row[1]) }}</span>
              <span v-else>{{ scope.row[1] }}</span>
            </template>
          </el-table-column>
        </el-table>
        
        <!-- 状态属性（从hasAttribute关系获取） -->
        <div v-if="searchForm.queryMode === 'state'">
          <el-divider content-position="left">
            <h4>状态属性值（hasAttribute关系）</h4>
          </el-divider>
          <el-table v-if="currentDetail.attributes && currentDetail.attributes.length > 0" 
            :data="currentDetail.attributes" border>
            <el-table-column prop="type" label="属性类型" width="250">
              <template #default="scope">
                <el-tag>{{ scope.row.type || '未知' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="value" label="属性值">
              <template #default="scope">
                <span style="word-break: break-all;">{{ scope.row.value }}</span>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="该状态节点暂无属性" />
        </div>
      </div>
    </el-dialog>

    <!-- 查询帮助对话框 -->
    <el-dialog v-model="helpDialogVisible" title="查询帮助 - 图谱结构说明" width="70%">
      <el-alert title="核心理念" type="info" :closable="false" style="margin-bottom: 20px;">
        <template #default>
          <p><strong>基础实体 (:entity)</strong>是静态骨架（地点、设施、事件），描述"是什么"</p>
          <p><strong>状态节点 (:State)</strong>是动态快照，描述"在何时发生了什么"，包含降雨、损失等数据</p>
          <p><strong>属性节点 (:Attribute)</strong>通过hasAttribute关系连接到状态，存储具体数值</p>
        </template>
      </el-alert>
      
      <el-collapse>
        <el-collapse-item title="📍 基础实体查询（:entity节点）" name="1">
          <p><strong>用途：</strong>查询实体基本信息（名称、位置、所属关系），不包含时序数据</p>
          <el-divider />
          <h4>实体类型与ID规范：</h4>
          <ul>
            <li><strong>地点 (:地点:entity)</strong>
              <ul>
                <li>行政区划：L-450100（南宁市）、L-450103（青秀区）</li>
                <li>自然地理：L-RIVER-长江、L-RIVER-珠江</li>
                <li>属性：id, name, admin_level, geo_description</li>
              </ul>
            </li>
            <li><strong>设施 (:设施:entity)</strong>
              <ul>
                <li>ID格式：F-450381-潘厂水库、F-420500-三峡大坝</li>
                <li>类型：水库、大坝、水文站、道路等</li>
                <li>属性：id, name, facility_type, geo_description</li>
              </ul>
            </li>
            <li><strong>事件 (:事件:entity)</strong>
              <ul>
                <li>ID格式：E-450000-20231001-TYPHOON</li>
                <li>类型：台风、强降雨、洪水等</li>
                <li>属性：id, name, geo_description</li>
              </ul>
            </li>
          </ul>
          <el-alert type="warning" :closable="false">
            <strong>注意：</strong>基础实体不存储降雨量、损失等时变数据！这些数据在状态节点中。
          </el-alert>
        </el-collapse-item>
        
        <el-collapse-item title="📊 状态节点查询（:State节点）" name="2">
          <p><strong>用途：</strong>查询时序数据、灾情统计、属性值（降雨、损失、受灾人口等）</p>
          <el-divider />
          <h4>状态类型与ID规范：</h4>
          <ul>
            <li><strong>事件状态 (ES-*)</strong>
              <ul>
                <li>ID格式：ES-E-450000-20231001-TYPHOON-20231001_20231010</li>
                <li>说明：事件在特定时间段的演化阶段</li>
              </ul>
            </li>
            <li><strong>地点状态 (LS-*)</strong>
              <ul>
                <li>ID格式：LS-L-450100-20231001_20231001</li>
                <li>说明：地点在某时段的降雨、水位、受灾情况</li>
              </ul>
            </li>
            <li><strong>设施状态 (FS-*)</strong>
              <ul>
                <li>ID格式：FS-F-450381-潘厂水库-20200607_20200607</li>
                <li>说明：设施的运行状态、监测数据、泄洪情况</li>
              </ul>
            </li>
            <li><strong>联合状态 (JS-*)</strong>
              <ul>
                <li>ID格式：JS-L-450100-L-450500-20231001_20231010</li>
                <li>说明：多个实体的汇总统计（如"南宁、北海两市总损失"）</li>
              </ul>
            </li>
          </ul>
          <el-divider />
          <h4>关键字段：</h4>
          <ul>
            <li><code>state_type</code>: event/location/facility/joint</li>
            <li><code>time</code>: 时间字符串（如"2023-10-01至2023-10-10"）</li>
            <li><code>start_time / end_time</code>: 日期对象，用于时间范围查询</li>
            <li><code>entity_ids</code>: 关联的基础实体ID数组</li>
            <li><code>attributes</code>: 属性列表（通过hasAttribute关系获取）</li>
          </ul>
          <el-alert type="success" :closable="false">
            <strong>重要：</strong>状态ID包含实体信息，可直接用关键词过滤！例如搜索"潘厂水库"可找到所有相关状态。
          </el-alert>
        </el-collapse-item>
        
        <el-collapse-item title="🔗 关系类型说明" name="3">
          <h4>空间关系（基础实体之间）：</h4>
          <ul>
            <li><strong>:locatedIn</strong> - 地点层级、设施归属（地点→上级地点，设施→地点）</li>
            <li><strong>:occurredAt</strong> - 事件发生地（事件→地点）</li>
          </ul>
          <el-divider />
          <h4>状态链关系：</h4>
          <ul>
            <li><strong>:hasState</strong> - 基础实体→首个状态节点</li>
            <li><strong>:nextState</strong> - 状态时间序列（状态→下一个状态）</li>
            <li><strong>:contain</strong> - 状态包含关系（父状态→子状态）</li>
          </ul>
          <el-divider />
          <h4>因果关系（状态之间，通过:hasRelation）：</h4>
          <ul>
            <li><strong>导致</strong> - 直接因果（type属性="导致"）</li>
            <li><strong>间接导致</strong> - 间接影响因素</li>
            <li><strong>隐含导致</strong> - 文本隐含的因果</li>
            <li><strong>触发</strong> - 阈值触发的响应行动</li>
          </ul>
          <el-divider />
          <h4>属性关系：</h4>
          <ul>
            <li><strong>:hasAttribute</strong> - 状态→属性节点（关系的type字段存储属性名，Attribute节点的value字段存储属性值）</li>
          </ul>
          <el-alert type="info" :closable="false">
            <strong>提示：</strong>查看"关系视图"标签页可探索实体的完整关系网络。
          </el-alert>
        </el-collapse-item>
        
        <el-collapse-item title="💡 查询技巧" name="4">
          <h4>✅ 高效查询策略：</h4>
          <ol>
            <li><strong>查询损失、降雨等数据 → 选择"状态节点"模式</strong>
              <ul>
                <li>这些数据存储在State节点的attributes中</li>
                <li>可按时间范围、属性类型筛选</li>
              </ul>
            </li>
            <li><strong>查询实体位置、名称 → 选择"基础实体"模式</strong>
              <ul>
                <li>可查看admin_level、geo_description等</li>
                <li>不支持时间范围筛选</li>
              </ul>
            </li>
            <li><strong>利用ID进行快速过滤</strong>
              <ul>
                <li>状态ID包含实体名称：搜"潘厂水库"可直接找到FS-F-450381-潘厂水库-*</li>
                <li>使用区划码：搜"450100"可找到南宁市相关的所有状态</li>
              </ul>
            </li>
            <li><strong>属性筛选</strong>
              <ul>
                <li>选择"降雨量"可快速定位包含降雨数据的状态</li>
                <li>选择"受灾人口"可找到灾情统计</li>
              </ul>
            </li>
            <li><strong>关系类型筛选</strong>
              <ul>
                <li>选择"导致"可找到因果链中的源头状态</li>
                <li>选择"触发"可找到引发预警的状态</li>
              </ul>
            </li>
          </ol>
          <el-divider />
          <h4>❌ 常见误区：</h4>
          <ul>
            <li><strong>误区1：</strong>在基础实体模式中使用时间范围筛选 → 无效，时间属性只在状态节点中</li>
            <li><strong>误区2：</strong>期望基础实体返回降雨、损失数据 → 应切换到状态节点模式</li>
            <li><strong>误区3：</strong>只关注事件状态(ES) → 损失数据可能在地点状态(LS)或联合状态(JS)中</li>
          </ul>
          <el-divider />
          <h4>🔧 高级功能：</h4>
          <ul>
            <li><strong>自定义Cypher</strong>：启用高级查询，输入原生Cypher语句（只读）</li>
            <li><strong>关系视图</strong>：选中行后切换到"关系视图"标签页，查看完整关系网络</li>
            <li><strong>时序分析</strong>：状态节点模式下，切换到"时序分析"标签页查看时间分布</li>
            <li><strong>详情对话框</strong>：点击"详情"按钮查看完整属性和hasAttribute关系</li>
          </ul>
        </el-collapse-item>
        
        <el-collapse-item title="📖 查询示例" name="5">
          <h4>示例1：查询2020年6月潘厂水库的泄洪情况</h4>
          <pre>模式：状态节点
关键词：潘厂水库
时间范围：2020-06-01 至 2020-06-30
状态类型：设施状态
→ 返回：FS-F-450381-潘厂水库-20200607_20200607 及其属性</pre>
          
          <h4>示例2：查询2023年10月南宁市的受灾人口</h4>
          <pre>模式：状态节点
关键词：南宁
时间范围：2023-10-01 至 2023-10-31
属性筛选：受灾人口
→ 返回：LS-L-450100-* 及 JS-* 状态，包含受灾人口属性</pre>
          
          <h4>示例3：查询所有水库设施</h4>
          <pre>模式：基础实体
实体类型：设施
关键词：水库
→ 返回：F-*-*水库 等设施实体</pre>
          
          <h4>示例4：查找有"导致"关系的状态</h4>
          <pre>模式：状态节点
关系类型：导致
→ 返回：所有参与因果链的状态节点</pre>
        </el-collapse-item>
      </el-collapse>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { 
  Search, RefreshLeft, Download, QuestionFilled, Right, Refresh,
  CaretRight, CaretBottom, Position, Connection, Clock, Notification
} from '@element-plus/icons-vue';
import { searchService } from '../api';

defineOptions({ name: 'SearchView' });

const router = useRouter();
const loading = ref(false);
const activeTab = ref('table');
const currentPage = ref(1);
const pageSize = ref(10);
const selectedEntity = ref(null);
const entityRelations = ref({ nodes: [], relationships: [] });
const relationsLoading = ref(false);
const locationOptions = ref([]);
const detailDialogVisible = ref(false);
const helpDialogVisible = ref(false);
const currentDetail = ref(null);
const detailLoading = ref(false);
const stateAttributes = ref([]);



// 关系分组展开状态
const expandedGroups = reactive({
  spatial: true,
  stateTree: true,
  stateChain: true,
  causal: true,
  attribute: false
});

// 节点展开状态（用于状态树）
const expandedNodes = ref({});

// 切换节点展开状态
const toggleNodeExpand = (nodeId) => {
  expandedNodes.value[nodeId] = !expandedNodes.value[nodeId];
};

// 获取状态节点标签
const getStateNodeLabel = (node) => {
  if (!node.properties) return 'State';
  const stateType = node.properties.state_type;
  const typeMap = {
    'event': '事件状态',
    'location': '地点状态',
    'facility': '设施状态',
    'joint': '联合状态'
  };
  return typeMap[stateType] || stateType || 'State';
};

// 格式化状态时间
const formatStateTime = (node) => {
  if (!node.properties) return '未知时间';
  return node.properties.time || node.properties.start_time || '未知时间';
};

// 搜索表单
const searchForm = reactive({
  queryMode: 'state', // 'entity' or 'state'
  category: '', // 基础实体类型
  stateType: '', // 状态类型
  keyword: '',
  attributeType: '', // 属性类型筛选
  relationType: '', // 关系类型筛选
  timeRange: [],
  location: [],
  documentSource: '',
  advancedOptions: false,
  cypherQuery: ''
});

// 文档来源
const documentSources = ref([]);

// 搜索结果
const allSearchResults = ref([]);

// 分页后的搜索结果
const searchResults = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value;
  const end = start + pageSize.value;
  return allSearchResults.value.slice(start, end);
});

// 查询模式切换
const handleQueryModeChange = () => {
  // 清空搜索结果
  allSearchResults.value = [];
  selectedEntity.value = null;
  entityRelations.value = { nodes: [], relationships: [] };
};

// 搜索实体
const searchEntities = async () => {
  loading.value = true;
  try {
    const params = {
      queryMode: searchForm.queryMode,
      category: searchForm.queryMode === 'entity' ? searchForm.category : 'State',
      stateType: searchForm.stateType,
      keyword: searchForm.keyword,
      attributeType: searchForm.attributeType,
      relationType: searchForm.relationType,
      timeRange: searchForm.timeRange,
      location: searchForm.location,
      documentSource: searchForm.documentSource,
      advancedQuery: searchForm.advancedOptions ? searchForm.cypherQuery : ''
    };
    
    const results = await searchService.searchEntities(params);
    allSearchResults.value = results;
    currentPage.value = 1;
    
    ElMessage.success(`找到 ${results.length} 条结果`);
  } catch (error) {
    allSearchResults.value = [];
    ElMessage.error('搜索失败: ' + (error.message || '未知错误'));
    console.error('实体搜索失败:', error);
  } finally {
    loading.value = false;
  }
};

// 重置表单
const resetForm = () => {
  searchForm.category = '';
  searchForm.stateType = '';
  searchForm.keyword = '';
  searchForm.attributeType = '';
  searchForm.relationType = '';
  searchForm.timeRange = [];
  searchForm.location = [];
  searchForm.documentSource = '';
  searchForm.advancedOptions = false;
  searchForm.cypherQuery = '';
  allSearchResults.value = [];
};

// 获取关键属性（只显示部分重要属性）
const getKeyProperties = (properties) => {
  if (!properties) return {};
  const keyProps = {};
  const importantKeys = ['name', 'admin_level', 'geo_description', 'facility_type'];
  importantKeys.forEach(key => {
    if (properties[key]) {
      keyProps[key] = properties[key];
    }
  });
  return keyProps;
};

// 获取行类名
const getRowClassName = ({ row }) => {
  if (searchForm.queryMode === 'state') {
    const stateType = row.properties?.state_type || '';
    return `state-row-${stateType}`;
  }
  return '';
};

// 获取实体类型标签颜色
const getEntityTypeTag = (category) => {
  const typeMap = {
    '地点': 'success',
    '设施': 'warning',
    '事件': 'danger'
  };
  return typeMap[category] || 'info';
};

// 获取状态类型标签颜色
const getStateTypeTag = (row) => {
  const stateType = row.properties?.state_type || '';
  const typeMap = {
    'event': 'danger',
    'location': 'success',
    'facility': 'warning',
    'joint': 'info'
  };
  return typeMap[stateType] || 'info';
};

// 获取状态类型名称
const getStateTypeName = (row) => {
  const stateType = row.properties?.state_type || '';
  const nameMap = {
    'event': '事件状态',
    'location': '地点状态',
    'facility': '设施状态',
    'joint': '联合状态'
  };
  return nameMap[stateType] || row.name || '状态';
};

// 获取实体ID简短名称（从完整ID中提取关键部分）
const getShortEntityName = (entityId) => {
  if (!entityId) return '';
  // L-450100 -> 450100
  // F-450381-潘厂水库 -> 潘厂水库
  // E-450000-20231001-TYPHOON -> TYPHOON
  const parts = entityId.split('-');
  if (parts.length >= 3 && parts[2]) {
    return parts.slice(2).join('-'); // 返回第三部分及之后
  }
  return parts[parts.length - 1] || entityId;
};

// 获取属性值的简短显示
const getShortValue = (value) => {
  if (!value) return '';
  const str = String(value);
  return str.length > 20 ? str.substring(0, 20) + '...' : str;
};

// 查看详情
const viewDetails = async (entity) => {
  currentDetail.value = entity;
  detailDialogVisible.value = true;
  detailLoading.value = false; // 数据已在列表中获取，无需再次加载
};

// 查看状态属性（打开详情对话框）
const viewStateAttributes = (entity) => {
  viewDetails(entity);
};

// 导出结果
const exportResults = () => {
  try {
    const headers = searchForm.queryMode === 'entity' 
      ? ['ID', '名称', '类型', '来源']
      : ['ID', '名称', '状态类型', '时间', '来源', '关联实体'];
    
    let csvContent = '\uFEFF' + headers.join(',') + '\n';
    
    allSearchResults.value.forEach(item => {
      if (searchForm.queryMode === 'entity') {
        csvContent += `"${item.id}","${item.name}","${item.category}","${item.source || ''}"\n`;
      } else {
        const stateType = item.properties?.state_type || '';
        const entityIds = item.entity_ids ? item.entity_ids.join(';') : '';
        csvContent += `"${item.id}","${item.name}","${stateType}","${item.time || ''}","${item.source || ''}","${entityIds}"\n`;
      }
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `知识图谱查询结果_${searchForm.queryMode}_${new Date().getTime()}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    ElMessage.success('导出成功');
  } catch (error) {
    ElMessage.error('导出失败');
    console.error('导出错误:', error);
  }
};

// 选择实体
const selectEntity = (entity) => {
  selectedEntity.value = entity;
  activeTab.value = 'relations';
  loadEntityRelations(entity.id);
};

// 加载实体关系
const loadEntityRelations = async (entityId) => {
  relationsLoading.value = true;
  try {
    const result = await searchService.getEntityRelations(entityId);
    entityRelations.value = result;
    
    // 如果是状态节点，构建状态树
    if (selectedEntity.value && selectedEntity.value.properties && 
        selectedEntity.value.properties.state_type) {
      buildStateTree();
    }
  } catch (error) {
    entityRelations.value = { nodes: [], relationships: [] };
    ElMessage.error('加载关系失败');
    console.error('获取实体关系失败:', error);
  } finally {
    relationsLoading.value = false;
  }
};

// 构建状态树结构（处理 nextState 和 contain 层级）
const stateTreeData = ref({ roots: [], allNodes: {} });

const buildStateTree = () => {
  console.log('开始构建状态树...');
  
  if (!entityRelations.value.relationships || !entityRelations.value.nodes) {
    console.log('没有关系或节点数据');
    stateTreeData.value = { roots: [], allNodes: {} };
    return;
  }

  const nodes = entityRelations.value.nodes;
  const relationships = entityRelations.value.relationships;
  
  console.log(`节点数: ${nodes.length}, 关系数: ${relationships.length}`);
  
  // 创建节点映射
  const nodeMap = {};
  nodes.forEach(node => {
    nodeMap[node.id] = {
      ...node,
      next: [],      // nextState 关系
      children: [],  // contain 关系
      parents: []    // 用于判断是否为根节点
    };
  });

  // 统计关系类型
  const relationTypeCounts = {};
  relationships.forEach(rel => {
    relationTypeCounts[rel.type] = (relationTypeCounts[rel.type] || 0) + 1;
  });
  console.log('关系类型统计:', relationTypeCounts);
  
  // 处理关系
  let nextStateCount = 0;
  let containCount = 0;
  let hasStateCount = 0;
  
  relationships.forEach(rel => {
    const sourceNode = nodeMap[rel.source];
    const targetNode = nodeMap[rel.target];
    
    if (!sourceNode || !targetNode) {
      console.log(`关系节点未找到: ${rel.source} -> ${rel.target}, type: ${rel.type}`);
      return;
    }
    
    if (rel.type === 'nextState') {
      // nextState: 时间序列，source -> target
      sourceNode.next.push(targetNode);
      targetNode.parents.push(sourceNode.id);
      nextStateCount++;
    } else if (rel.type === 'contain') {
      // contain: 包含关系，source 包含 target
      sourceNode.children.push(targetNode);
      targetNode.parents.push(sourceNode.id);
      containCount++;
    } else if (rel.type === 'hasState') {
      // hasState: 基础实体 -> 首个状态，也算作时间序列的起点
      sourceNode.next.push(targetNode);
      targetNode.parents.push(sourceNode.id);
      hasStateCount++;
    }
  });
  
  console.log(`nextState关系: ${nextStateCount}, contain关系: ${containCount}, hasState关系: ${hasStateCount}`);

  // 找出根节点（没有 parents 的节点）
  const roots = [];
  Object.values(nodeMap).forEach(node => {
    // 只处理 State 节点
    if (node.labels && node.labels.includes('State')) {
      if (node.parents.length === 0) {
        roots.push(node);
      }
    }
  });
  
  console.log(`找到 ${roots.length} 个根节点`);
  console.log('根节点:', roots.map(r => r.id));

  stateTreeData.value = {
    roots: roots,
    allNodes: nodeMap
  };
  
  console.log('状态树构建完成:', stateTreeData.value);
};

// 根据ID获取节点
const getNodeById = (nodeId) => {
  return entityRelations.value.nodes?.find(n => String(n.id) === String(nodeId));
};

// 获取节点名称
const getNodeName = (nodeId) => {
  const node = getNodeById(nodeId);
  if (!node) return nodeId;
  return node.properties?.name || node.properties?.id || nodeId;
};

// 获取节点类型颜色
const getNodeTypeColor = (node) => {
  if (!node) return 'info';
  const labels = node.labels || [];
  if (labels.includes('地点')) return 'success';
  if (labels.includes('设施')) return 'warning';
  if (labels.includes('事件')) return 'danger';
  if (labels.includes('State')) return 'primary';
  return 'info';
};

// 切换分组展开/折叠
const toggleGroup = (groupName) => {
  expandedGroups[groupName] = !expandedGroups[groupName];
};

// 获取唯一关系类型
const getUniqueRelationTypes = () => {
  if (!entityRelations.value.relationships) return [];
  const types = new Set(entityRelations.value.relationships.map(r => r.type));
  return Array.from(types);
};

// 获取空间关系 (locatedIn, occurredAt)
const getSpatialRelations = () => {
  if (!entityRelations.value.relationships) return [];
  return entityRelations.value.relationships.filter(r => 
    ['locatedIn', 'occurredAt'].includes(r.type)
  );
};

// 获取其他状态链关系（排除 nextState 和 contain，它们在状态树中展示）
const getOtherStateChainRelations = () => {
  if (!entityRelations.value.relationships) return [];
  return entityRelations.value.relationships.filter(r => 
    ['hasState'].includes(r.type)
  );
};

// 获取因果关系 (hasRelation，根据properties.type区分)
const getCausalRelations = () => {
  if (!entityRelations.value.relationships) return [];
  return entityRelations.value.relationships.filter(r => 
    r.type === 'hasRelation' && r.properties && r.properties.type
  );
};

// 获取属性关系 (hasAttribute)
const getAttributeRelations = () => {
  if (!entityRelations.value.relationships) return [];
  return entityRelations.value.relationships.filter(r => 
    r.type === 'hasAttribute'
  );
};

// 获取属性值
const getAttributeValue = (nodeId) => {
  const node = getNodeById(nodeId);
  if (!node || !node.properties) return '';
  return node.properties.value || '';
};

// 在图谱中查看
const viewInGraph = (entity) => {
  router.push({
    path: '/graph',
    query: {
      entityId: entity.id,
      highlight: 'true'
    }
  });
};

// 查看因果链
const viewCausalChain = (entity) => {
  // 可以跳转到专门的因果链分析页面
  ElMessage.info('因果链分析功能开发中');
};

// 显示查询帮助
const showQueryHelp = () => {
  helpDialogVisible.value = true;
};

// 时序分析相关
const getTimeSpan = () => {
  if (!allSearchResults.value.length) return '-';
  const times = allSearchResults.value
    .map(r => r.time)
    .filter(t => t)
    .sort();
  if (!times.length) return '-';
  return `${times[0]} ~ ${times[times.length - 1]}`;
};

const getUniqueEntities = () => {
  const entities = new Set();
  allSearchResults.value.forEach(r => {
    if (r.entity_ids) {
      r.entity_ids.forEach(id => entities.add(id));
    }
  });
  return entities.size;
};

const getTimelineData = () => {
  return allSearchResults.value
    .filter(r => r.time)
    .slice(0, 20)
    .map(r => ({
      id: r.id,
      time: r.time,
      name: r.name || r.id,
      description: `${r.properties?.state_type || ''} - ${r.entity_ids?.join(', ') || ''}`,
      type: getStateTypeTag(r).replace('success', 'primary')
    }));
};

onMounted(async () => {
  try {
    // 加载地理位置选项
    const geoCode = await searchService.getGeoCode();
    locationOptions.value = geoCode;
    
    // 加载文档来源
    const sources = await searchService.getDocumentSources();
    documentSources.value = sources;
    
    // 初始化时执行一次搜索
    await searchEntities();
  } catch (error) {
    console.error('初始化失败:', error);
  }
});
</script>

<style scoped>
.search-container {
  padding: 20px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.search-form {
  padding: 10px 0;
}

.search-results {
  min-height: 300px;
}

.pagination-container {
  margin-top: 20px;
  display: flex;
  justify-content: center;
}

.property-item {
  margin-bottom: 5px;
  display: flex;
  align-items: center;
  gap: 5px;
}

.property-key {
  font-weight: bold;
  margin-right: 5px;
}

.property-value {
  flex: 1;
  word-break: break-all;
  color: #606266;
}

/* 状态信息样式 */
.state-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.entity-ids-section,
.attributes-section {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.entity-id-tag {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 状态行颜色 */
:deep(.el-table .state-row-event) {
  background-color: #fef0f0;
}

:deep(.el-table .state-row-location) {
  background-color: #f0f9ff;
}

:deep(.el-table .state-row-facility) {
  background-color: #fdf6ec;
}

:deep(.el-table .state-row-joint) {
  background-color: #f4f4f5;
}

/* 关系视图 */
.relations-view {
  min-height: 400px;
  padding: 20px;
}

.entity-relations {
  padding: 10px;
}

.relation-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-left h4 {
  margin: 0;
}

/* 关系树结构 */
.relations-tree {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.relation-group {
  background: #f8f9fb;
  border-radius: 8px;
  padding: 12px;
  border: 1px solid #e8eaf0;
}

.group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  padding: 4px;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.group-header:hover {
  background-color: rgba(24, 144, 255, 0.05);
}

.expand-icon {
  font-size: 14px;
  transition: transform 0.3s;
  color: #1890ff;
}

.expand-icon.expanded {
  transform: rotate(0deg);
}

.group-title {
  font-weight: 600;
  font-size: 14px;
  color: #2c3e50;
}

.group-badge {
  margin-left: auto;
}

.group-content {
  margin-top: 12px;
  padding-left: 8px;
}

/* 关系节点 */
.relation-node {
  position: relative;
  margin-bottom: 12px;
  padding-left: 20px;
}

.node-connector {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  border-radius: 2px;
}

.node-connector.spatial {
  background: linear-gradient(135deg, #52c41a 0%, #389e0d 100%);
}

.node-connector.chain {
  background: linear-gradient(135deg, #1890ff 0%, #096dd9 100%);
}

.node-connector.chain.nextState {
  background: linear-gradient(135deg, #13c2c2 0%, #08979c 100%);
}

.node-connector.chain.contain {
  background: linear-gradient(135deg, #722ed1 0%, #531dab 100%);
}

.node-connector.causal {
  background: linear-gradient(135deg, #fa8c16 0%, #d46b08 100%);
}

.node-connector.causal.导致 {
  background: linear-gradient(135deg, #f5222d 0%, #cf1322 100%);
}

.node-connector.causal.触发 {
  background: linear-gradient(135deg, #faad14 0%, #d48806 100%);
}

.relation-card {
  background: white;
  border-radius: 6px;
  padding: 12px;
  border: 1px solid #e8eaf0;
  transition: all 0.2s;
}

.relation-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  border-color: #1890ff;
}

.relation-card.highlight {
  border-color: #fa8c16;
  background: #fff7e6;
}

.relation-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.relation-type {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
}

.relation-type.spatial {
  background: rgba(82, 196, 26, 0.1);
  color: #389e0d;
}

.relation-type.chain {
  background: rgba(24, 144, 255, 0.1);
  color: #096dd9;
}

.relation-type.chain.nextState {
  background: rgba(19, 194, 194, 0.1);
  color: #08979c;
}

.relation-type.chain.contain {
  background: rgba(114, 46, 209, 0.1);
  color: #531dab;
}

.relation-type.causal {
  background: rgba(250, 140, 22, 0.1);
  color: #d46b08;
}

.relation-type.causal.导致 {
  background: rgba(245, 34, 45, 0.1);
  color: #cf1322;
}

.relation-time {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #8c8c8c;
}

.relation-basis {
  margin-top: 8px;
  padding: 8px;
  background: rgba(24, 144, 255, 0.05);
  border-radius: 4px;
  font-size: 12px;
}

/* 属性列表 */
.group-content.attributes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 8px;
  padding: 8px;
}

.attribute-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  background: white;
  border-radius: 4px;
  border: 1px solid #e8eaf0;
}

.attribute-value {
  flex: 1;
  font-size: 13px;
  color: #2c3e50;
  font-weight: 500;
}

/* 状态树容器 */
.state-tree-container {
  padding: 12px 8px;
}

.state-tree-root {
  margin-bottom: 16px;
}

.state-tree-root:last-child {
  margin-bottom: 0;
}

/* 内联状态节点 */
.inline-state-node {
  position: relative;
}

.state-node-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 8px;
  background: white;
  border-radius: 6px;
  border: 1px solid #e8eaf0;
  transition: all 0.2s;
  cursor: pointer;
}

.state-node-item:hover {
  border-color: #1890ff;
  box-shadow: 0 2px 6px rgba(24, 144, 255, 0.15);
  transform: translateX(2px);
}

.state-node-item.sub {
  padding: 6px 10px;
  font-size: 13px;
}

.expand-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  background: rgba(24, 144, 255, 0.08);
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
}

.expand-btn:hover {
  background: rgba(24, 144, 255, 0.15);
  transform: scale(1.1);
}

.expand-btn .el-icon {
  font-size: 14px;
  color: #1890ff;
}

.expand-placeholder {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.state-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: linear-gradient(135deg, #1890ff 0%, #096dd9 100%);
  flex-shrink: 0;
  box-shadow: 0 2px 4px rgba(24, 144, 255, 0.3);
  border: 2px solid white;
}

.state-dot.event {
  background: linear-gradient(135deg, #f5222d 0%, #cf1322 100%);
  box-shadow: 0 2px 4px rgba(245, 34, 45, 0.3);
}

.state-dot.location {
  background: linear-gradient(135deg, #52c41a 0%, #389e0d 100%);
  box-shadow: 0 2px 4px rgba(82, 196, 26, 0.3);
}

.state-dot.facility {
  background: linear-gradient(135deg, #faad14 0%, #d48806 100%);
  box-shadow: 0 2px 4px rgba(250, 173, 20, 0.3);
}

.state-dot.joint {
  background: linear-gradient(135deg, #722ed1 0%, #531dab 100%);
  box-shadow: 0 2px 4px rgba(114, 46, 209, 0.3);
}

.state-info-box {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.state-label {
  font-size: 13px;
  font-weight: 600;
  color: #2c3e50;
}

.state-time-text {
  font-size: 12px;
  color: #8c8c8c;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 子状态和下一个状态 */
.state-children,
.state-next {
  position: relative;
  margin-left: 28px;
  margin-top: -4px;
}

.child-wrapper,
.next-wrapper {
  position: relative;
  padding-left: 20px;
  margin-bottom: 4px;
}

.branch-line {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  border-radius: 2px;
}

.branch-line.contain {
  background: linear-gradient(135deg, #722ed1 0%, #531dab 100%);
}

.branch-line.next {
  background: linear-gradient(135deg, #13c2c2 0%, #08979c 100%);
}

.child-wrapper.contain::before {
  content: 'contain';
  position: absolute;
  left: 6px;
  top: -14px;
  font-size: 10px;
  color: #722ed1;
  background: white;
  padding: 0 4px;
  border-radius: 2px;
  font-weight: 600;
}

.next-wrapper::before {
  content: 'next';
  position: absolute;
  left: 6px;
  top: -14px;
  font-size: 10px;
  color: #13c2c2;
  background: white;
  padding: 0 4px;
  border-radius: 2px;
  font-weight: 600;
}

.no-relations,
.no-selection {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 300px;
  color: #909399;
}

/* 时序分析 */
.temporal-view {
  padding: 20px;
  min-height: 400px;
}

.temporal-stats {
  display: flex;
  justify-content: space-around;
  align-items: flex-start;
  gap: 20px;
  margin-bottom: 20px;
}

.temporal-chart {
  margin-top: 20px;
}

.timeline-container {
  max-height: 600px;
  overflow-y: auto;
  padding: 20px;
}

/* 详情对话框 */
:deep(.el-dialog__body) {
  max-height: 70vh;
  overflow-y: auto;
}

/* 响应式 */
@media (max-width: 768px) {
  .card-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
  
  .temporal-stats {
    flex-direction: column;
    gap: 10px;
  }
}
</style>